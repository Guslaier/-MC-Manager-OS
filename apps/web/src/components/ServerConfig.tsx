import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EulaStatus,
  FileEntry,
  JavaInstallReport,
  JavaVersion,
  ProvisionReport,
  ServerRecord,
  StorageStatus,
} from "@mcm/contracts";
import { DEFAULT_SCRIPT_RUN, JAVA_VERSIONS } from "@mcm/contracts";
import { api, describeError } from "../api";
import { Banner, ErrorText } from "./Feedback";
import { formatBytes } from "../lib/format";

const RAM_PRESETS = [
  { label: "2 GB", mb: 2048 },
  { label: "4 GB", mb: 4096 },
  { label: "6 GB", mb: 6144 },
  { label: "8 GB", mb: 8192 },
  { label: "12 GB", mb: 12288 },
  { label: "16 GB", mb: 16384 },
];

const CPU_PRESETS = [1, 2, 4, 8];

export function ServerConfig({
  server,
  provision,
  onChanged,
  onDelete,
}: {
  server: ServerRecord;
  provision: ProvisionReport | null;
  onChanged: () => void;
  onDelete: () => void;
}) {
  // Form fields
  const [name, setName] = useState(server.name);
  const [gamePort, setGamePort] = useState(String(server.gamePort));
  const [memoryMb, setMemoryMb] = useState(String(server.memoryMb));
  const [cpuCores, setCpuCores] = useState(String(server.cpuCores));
  const [scriptRun, setScriptRun] = useState(server.scriptRun);
  const [optimizeHeavyModpack, setOptimizeHeavyModpack] = useState(server.optimizeHeavyModpack !== false);

  // Status & Async State
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [javaReports, setJavaReports] = useState<JavaInstallReport[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [installingJava, setInstallingJava] = useState<JavaVersion | null>(null);
  const [uploadingJar, setUploadingJar] = useState(false);
  const [eulaStatus, setEulaStatus] = useState<EulaStatus | null>(null);
  const [eulaUpdating, setEulaUpdating] = useState(false);

  const isRunning = server.state === "running";
  const isBedrock = server.serverType === "bedrock";
  const defaultPort = isBedrock ? "19132" : "25565";
  const defaultCmd = isBedrock ? "./bedrock_server" : DEFAULT_SCRIPT_RUN;

  // Check for unsaved changes
  const isDirty = useMemo(() => {
    return (
      name !== server.name ||
      gamePort !== String(server.gamePort) ||
      memoryMb !== String(server.memoryMb) ||
      cpuCores !== String(server.cpuCores) ||
      scriptRun !== server.scriptRun ||
      optimizeHeavyModpack !== (server.optimizeHeavyModpack !== false)
    );
  }, [name, gamePort, memoryMb, cpuCores, scriptRun, optimizeHeavyModpack, server]);

  // Sync state when server prop changes
  const resetForm = useCallback(() => {
    setName(server.name);
    setGamePort(String(server.gamePort));
    setMemoryMb(String(server.memoryMb));
    setCpuCores(String(server.cpuCores));
    setScriptRun(server.scriptRun);
    setOptimizeHeavyModpack(server.optimizeHeavyModpack !== false);
  }, [server]);

  useEffect(() => {
    resetForm();
  }, [resetForm]);

  // Load files in server dir (for .jar detection)
  const loadFiles = useCallback(() => {
    api
      .listFiles(server.id, server.id)
      .then((listing) => setEntries(listing.entries))
      .catch(() => {});
  }, [server.id]);

  // Load Java installations status
  const loadJava = useCallback(() => {
    api
      .java()
      .then(setJavaReports)
      .catch(() => {});
  }, []);

  // Load EULA status
  const loadEula = useCallback(() => {
    if (server.serverType === "bedrock") return;
    api
      .getEula(server.id)
      .then(setEulaStatus)
      .catch(() => setEulaStatus(null));
  }, [server.id, server.serverType]);

  // Load storage diagnostics
  useEffect(() => {
    api
      .storage()
      .then(setStorageStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadFiles();
    loadJava();
    loadEula();
  }, [loadFiles, loadJava, loadEula]);

  const jarFiles = useMemo(() => {
    return entries.filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".jar"));
  }, [entries]);

  // Save full configuration
  async function saveConfig() {
    if (isRunning) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateServer(server.id, {
        name,
        gamePort: Number(gamePort),
        memoryMb: Number(memoryMb),
        cpuCores: Number(cpuCores),
        scriptRun,
        optimizeHeavyModpack,
      });
      setNotice("Configuration saved successfully.");
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  }

  // Change Java Version
  async function setJava(version: JavaVersion) {
    if (isRunning) return;
    setError(null);
    try {
      await api.updateServer(server.id, { javaVersion: version });
      setNotice(`Java runtime switched to Java ${version}.`);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Install Java version on host
  async function installJava(version: JavaVersion) {
    setInstallingJava(version);
    setError(null);
    try {
      const report = await api.javaInstall(version);
      setJavaReports((prev) => prev.map((r) => (r.version === version ? report : r)));
      setNotice(`Java ${version} installed successfully.`);
      loadJava();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setInstallingJava(null);
    }
  }

  // Select launch jar
  async function pickJar(jarName: string) {
    if (isRunning) return;
    setError(null);
    try {
      await api.selectServerJar(server.id, jarName);
      setNotice(`Selected ${jarName} as active launch jar.`);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Toggle Minecraft EULA
  async function toggleEula(accepted: boolean) {
    if (isRunning) return;
    setEulaUpdating(true);
    setError(null);
    try {
      const res = await api.setEula(server.id, accepted);
      setEulaStatus(res);
      setNotice(accepted ? "EULA accepted successfully." : "EULA declined.");
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setEulaUpdating(false);
    }
  }

  // Upload a new jar file
  async function handleJarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".jar")) {
      setError("Please select a valid .jar file.");
      return;
    }

    setUploadingJar(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.uploadServerJar({ serverId: server.id, path: `${server.id}/server.jar` }, file);
      setNotice(`Uploaded ${file.name} (${formatBytes(res.totalBytes)}) as server.jar.`);
      loadFiles();
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUploadingJar(false);
    }
  }

  const memoryNumber = Number(memoryMb) || 0;
  const memoryGbFormatted =
    memoryNumber > 0
      ? (memoryNumber % 1024 === 0 || Math.abs(memoryNumber - 16000) <= 200
          ? `${Math.round(memoryNumber / 1024)}`
          : (memoryNumber / 1024).toFixed(1))
      : "0";

  const isRamPresetActive = (presetMb: number) => {
    return memoryNumber === presetMb || Math.abs(memoryNumber - presetMb) <= 500;
  };

  return (
    <div className="cfg-view">
      {/* Running Banner Notice */}
      {isRunning && (
        <Banner>
          Server is running — Stop the server to edit hardware limits, Java version, or startup settings.
        </Banner>
      )}

      {error && <ErrorText message={error} />}
      {notice && <p className="pw-notice">{notice}</p>}

      {/* 1. General & Hardware Allocation */}
      <section className="card cfg-panel" aria-labelledby="cfg-general-title">
        <header className="cfg-head">
          <span className="codicon codicon-dashboard" aria-hidden="true" />
          <h3 id="cfg-general-title">General & Hardware Resources</h3>
          <span className="cfg-desc">Define server identity, network port, and allocated CPU/RAM</span>
        </header>

        <div className="cfg-grid-2">
          {/* Row 1, Col 1: Server Name */}
          <div className="cfg-field">
            <div className="cfg-field-header">
              <label htmlFor="cfg-server-name">Server Display Name</label>
              <span className="cfg-field-sub">Custom server title</span>
            </div>
            <input
              id="cfg-server-name"
              type="text"
              value={name}
              disabled={isRunning}
              placeholder="My Minecraft Server"
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Row 1, Col 2: Network Port */}
          <div className="cfg-field">
            <div className="cfg-field-header">
              <label htmlFor="cfg-server-port">Server Port {isBedrock ? "(UDP)" : "(TCP)"}</label>
              <button
                type="button"
                className="cfg-btn-sm"
                disabled={isRunning || gamePort === defaultPort}
                onClick={() => setGamePort(defaultPort)}
              >
                Default ({defaultPort})
              </button>
            </div>
            <input
              id="cfg-server-port"
              type="number"
              min={1024}
              max={65535}
              value={gamePort}
              disabled={isRunning}
              onChange={(e) => setGamePort(e.target.value)}
            />
          </div>

          {/* Row 2, Col 1: RAM Allocation */}
          <div className="cfg-field">
            <div className="cfg-field-header">
              <label htmlFor="cfg-server-ram">Memory Limit (RAM)</label>
              <span className="cfg-field-sub">
                <strong>{memoryMb} MB</strong> (~{memoryGbFormatted} GB)
              </span>
            </div>
            <input
              id="cfg-server-ram"
              type="number"
              step={512}
              min={1024}
              value={memoryMb}
              disabled={isRunning}
              onChange={(e) => setMemoryMb(e.target.value)}
            />
            {/* Quick Presets */}
            <div className="cfg-presets">
              {RAM_PRESETS.map((p) => (
                <button
                  key={p.mb}
                  type="button"
                  className={`cfg-preset-pill${isRamPresetActive(p.mb) ? " active" : ""}`}
                  disabled={isRunning}
                  onClick={() => setMemoryMb(String(p.mb))}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Row 2, Col 2: CPU Cores */}
          <div className="cfg-field">
            <div className="cfg-field-header">
              <label htmlFor="cfg-server-cpu">CPU Cores Allocation</label>
              <span className="cfg-field-sub">{cpuCores} Core(s)</span>
            </div>
            <input
              id="cfg-server-cpu"
              type="number"
              min={1}
              max={64}
              value={cpuCores}
              disabled={isRunning}
              onChange={(e) => setCpuCores(e.target.value)}
            />
            {/* Quick Presets */}
            <div className="cfg-presets">
              {CPU_PRESETS.map((cores) => (
                <button
                  key={cores}
                  type="button"
                  className={`cfg-preset-pill${cpuCores === String(cores) ? " active" : ""}`}
                  disabled={isRunning}
                  onClick={() => setCpuCores(String(cores))}
                >
                  {cores} {cores === 1 ? "Core" : "Cores"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Permanent Save Action Footer */}
        <footer className="cfg-footer">
          <span className="muted" style={{ fontSize: 13 }}>
            {isRunning
              ? "Stop server to edit or save configuration."
              : isDirty
                ? "You have unsaved changes."
                : "All configuration settings are saved."}
          </span>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {isDirty && (
              <button
                type="button"
                className="ghost"
                disabled={saving || isRunning}
                onClick={resetForm}
              >
                Discard
              </button>
            )}
            <button
              type="button"
              disabled={saving || isRunning || !isDirty}
              title={
                isRunning
                  ? "Stop server first"
                  : !isDirty
                    ? "No changes to save"
                    : "Save configuration changes"
              }
              onClick={() => void saveConfig()}
            >
              {saving ? "Saving..." : isRunning ? "Stop server to save" : "Save configuration"}
            </button>
          </div>
        </footer>
      </section>

      {/* 2. Server Core & Java Environment */}
      <section className="card cfg-panel" aria-labelledby="cfg-core-title">
        <header className="cfg-head">
          <span className={`codicon ${isBedrock ? "codicon-game" : "codicon-package"}`} aria-hidden="true" />
          <h3 id="cfg-core-title">{isBedrock ? "Bedrock Dedicated Server Software" : "Server Core & Java Runtime"}</h3>
          <span className="cfg-desc">
            {isBedrock
              ? "Bedrock Edition native Linux binary environment"
              : "Choose the launch executable (.jar) and matching Java JRE"}
          </span>
        </header>

        {isBedrock ? (
          <div style={{ padding: "16px", borderRadius: "8px", background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
              <span className="codicon codicon-game" style={{ fontSize: "20px", color: "#38bdf8" }} />
              <strong style={{ color: "#38bdf8", fontSize: "14px" }}>Bedrock Dedicated Server (BDS) Mode Active</strong>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: "13px" }}>
              เซิร์ฟเวอร์รันในโหมด Bedrock Edition โดยใช้ native Linux C++ binary (<code>bedrock_server</code>) ผ่าน Ubuntu glibc container ไม่จำเป็นต้องติดตั้งหรือใช้ Java Runtime Environment (JRE)
            </p>
          </div>
        ) : (
          <>

        {/* Active Jar Status Banner */}
        <div className={`cfg-jar-status-card${!server.jarFile ? " warn" : ""}`}>
          <div className="cfg-jar-info">
            <span
              className={`codicon ${server.jarFile ? "codicon-check" : "codicon-warning"}`}
              aria-hidden="true"
            />
            <div>
              <div className="cfg-jar-name">
                {server.jarFile ? `Active Core: ${server.jarFile}` : "No Launch Jar Selected"}
              </div>
              <div className="cfg-jar-sub">
                {server.jarFile
                  ? "This jar is executed when the server starts."
                  : "Upload or select a core .jar file below to launch the server."}
              </div>
            </div>
          </div>
          <label className="button ghost" style={{ cursor: isRunning ? "not-allowed" : "pointer" }}>
            <span className="codicon codicon-cloud-upload" aria-hidden="true" />
            <span>{uploadingJar ? "Uploading..." : "Upload Core .jar"}</span>
            <input
              type="file"
              accept=".jar"
              style={{ display: "none" }}
              disabled={isRunning || uploadingJar}
              onChange={(e) => void handleJarUpload(e)}
            />
          </label>
        </div>

        {/* Available Jars Table */}
        {jarFiles.length > 0 ? (
          <div>
            <div className="cfg-field-header" style={{ marginBottom: 6 }}>
              <span>Detected .jar files in server directory</span>
            </div>
            <table className="cfg-table">
              <thead>
                <tr>
                  <th>File Name</th>
                  <th>Size</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jarFiles.map((jar) => {
                  const isActive = server.jarFile === jar.name;
                  return (
                    <tr key={jar.name} className={isActive ? "active-row" : ""}>
                      <td>
                        <code>{jar.name}</code>
                        {isActive && <span className="pw-badge" style={{ marginLeft: 8 }}>Active</span>}
                      </td>
                      <td className="muted">{formatBytes(jar.sizeBytes)}</td>
                      <td>
                        <button
                          type="button"
                          className="cfg-btn-sm"
                          disabled={isRunning || isActive}
                          onClick={() => void pickJar(jar.name)}
                        >
                          {isActive ? "Selected" : "Set as Launch Jar"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No .jar files found in the server directory. Upload your server software (e.g. <code>paper.jar</code>, <code>fabric-server.jar</code>) using the button above.
          </p>
        )}

        {/* Java Environment Selection */}
        <div className="cfg-grid-2" style={{ marginTop: 6, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <div className="cfg-field">
            <div className="cfg-field-header">
              <label htmlFor="cfg-java-version">Java Runtime Version (JRE)</label>
              <span className="cfg-field-sub">Required by Minecraft version</span>
            </div>
            <select
              id="cfg-java-version"
              value={server.javaVersion}
              disabled={isRunning}
              onChange={(e) => void setJava(e.target.value as JavaVersion)}
            >
              {JAVA_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  Java {v} {v === "21" ? "(MC 1.20.5+)" : v === "17" ? "(MC 1.18 - 1.20.4)" : "(MC 1.16.5 and older)"}
                </option>
              ))}
            </select>
          </div>

          {/* Java Status on Host */}
          <div className="cfg-field">
            <div className="cfg-field-header">
              <span>Java Installation Status</span>
            </div>
            {(() => {
              const currentReport = javaReports.find((r) => r.version === server.javaVersion);
              const isInstalled = currentReport?.installed;
              const isInstalling = installingJava === server.javaVersion;
              return (
                <div className="cfg-jar-status-card" style={{ padding: "8px 12px" }}>
                  <div className="cfg-jar-info">
                    <span
                      className={`codicon ${isInstalled ? "codicon-check" : "codicon-info"}`}
                      style={{ color: isInstalled ? "#10b981" : "#f59e0b" }}
                      aria-hidden="true"
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        Java {server.javaVersion}: {isInstalled ? "Installed & Ready" : "Not Installed"}
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {currentReport?.versionOutput ?? (isInstalled ? "Alpine openjdk" : "Needs installation")}
                      </div>
                    </div>
                  </div>
                  {!isInstalled && (
                    <button
                      type="button"
                      className="cfg-btn-sm"
                      disabled={isInstalling}
                      onClick={() => void installJava(server.javaVersion)}
                    >
                      {isInstalling ? "Installing..." : "Install Now"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Minecraft EULA Section for Java servers */}
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <div className="cfg-field-header" style={{ marginBottom: 8 }}>
            <label>Minecraft EULA Agreement (eula.txt)</label>
            <a
              href="https://aka.ms/MinecraftEULA"
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}
            >
              Official Minecraft EULA <span className="codicon codicon-link-external" style={{ fontSize: 11 }} />
            </a>
          </div>
          <div
            className="cfg-jar-status-card"
            style={{
              padding: "10px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              background: eulaStatus?.state === "accepted" ? "rgba(16, 185, 129, 0.08)" : "rgba(245, 158, 11, 0.08)",
              border: `1px solid ${eulaStatus?.state === "accepted" ? "rgba(16, 185, 129, 0.25)" : "rgba(245, 158, 11, 0.25)"}`,
            }}
          >
            <div className="cfg-jar-info">
              <span
                className={`codicon ${eulaStatus?.state === "accepted" ? "codicon-check" : "codicon-warning"}`}
                style={{ color: eulaStatus?.state === "accepted" ? "#10b981" : "#f59e0b", fontSize: 18 }}
                aria-hidden="true"
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  EULA Status:{" "}
                  {eulaStatus?.state === "accepted"
                    ? "Accepted (eula=true)"
                    : eulaStatus?.state === "declined"
                    ? "Declined (eula=false) — Server will fail to launch"
                    : "Not Yet Generated (Missing) — Auto-accepted on startup"}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {eulaStatus?.state === "accepted"
                    ? "Server is authorized to run in compliance with Mojang specifications."
                    : "Minecraft Java requires explicit agreement to Mojang EULA in eula.txt to operate."}
                </div>
              </div>
            </div>
            <div>
              {eulaStatus?.state === "accepted" ? (
                <button
                  type="button"
                  className="cfg-btn-sm ghost"
                  disabled={isRunning || eulaUpdating}
                  onClick={() => void toggleEula(false)}
                >
                  {eulaUpdating ? "Saving..." : "Decline EULA"}
                </button>
              ) : (
                <button
                  type="button"
                  className="cfg-btn-sm primary"
                  disabled={isRunning || eulaUpdating}
                  onClick={() => void toggleEula(true)}
                >
                  {eulaUpdating ? "Saving..." : "Accept EULA"}
                </button>
              )}
            </div>
          </div>
        </div>
          </>
        )}
      </section>

      {/* 3. Startup & Modpack Optimization */}
      <section className="card cfg-panel" aria-labelledby="cfg-startup-title">
        <header className="cfg-head">
          <span className="codicon codicon-terminal" aria-hidden="true" />
          <h3 id="cfg-startup-title">Startup Command & Modpack Settings</h3>
          <span className="cfg-desc">Customize process execution arguments and file handle limits</span>
        </header>

        {/* Startup Command */}
        <div className="cfg-field">
          <div className="cfg-field-header">
            <label htmlFor="cfg-startup-cmd">Startup Command Line</label>
            <button
              type="button"
              className="cfg-btn-sm"
              disabled={isRunning || scriptRun === defaultCmd}
              onClick={() => setScriptRun(defaultCmd)}
            >
              Reset to Default
            </button>
          </div>
          <input
            id="cfg-startup-cmd"
            type="text"
            value={scriptRun}
            placeholder={defaultCmd}
            disabled={isRunning}
            onChange={(e) => setScriptRun(e.target.value)}
          />
          <span className="muted" style={{ fontSize: 12 }}>
            Standard default: <code>{defaultCmd}</code>
          </span>
        </div>

        {/* Heavy Modpack Toggle */}
        <label className="cfg-toggle-card">
          <input
            type="checkbox"
            checked={optimizeHeavyModpack}
            disabled={isRunning}
            onChange={(e) => setOptimizeHeavyModpack(e.target.checked)}
          />
          <div className="cfg-toggle-content">
            <span className="cfg-toggle-title">Optimize for Heavy Modpacks (Unlock File Limits)</span>
            <span className="cfg-toggle-desc">
              Raises container open-file descriptor limit (<code>ulimit -n 65535</code>). Highly recommended for Forge, Fabric, or NeoForge modpacks with 100+ mods to prevent "Too many open files" crash errors.
            </span>
          </div>
        </label>

        <footer className="cfg-footer">
          <span className="muted" style={{ fontSize: 13 }}>
            {isRunning ? "Stop server to save startup settings." : "Applies to subsequent server startups."}
          </span>
          <button
            type="button"
            disabled={saving || isRunning || !isDirty}
            onClick={() => void saveConfig()}
          >
            {saving ? "Saving..." : isRunning ? "Stop server to save" : "Save configuration"}
          </button>
        </footer>
      </section>

      {/* 4. System & Storage Diagnostics */}
      <section className="card cfg-panel" aria-labelledby="cfg-system-title">
        <header className="cfg-head">
          <span className="codicon codicon-server" aria-hidden="true" />
          <h3 id="cfg-system-title">System & Storage Information</h3>
          <span className="cfg-desc">Internal container paths and engine status</span>
        </header>

        <dl className="kv" style={{ margin: 0 }}>
          <dt>Server ID</dt>
          <dd>
            <code>{server.id}</code>
          </dd>
          <dt>Server Root</dt>
          <dd>
            <code>{`/server/${server.id}`}</code>
          </dd>
          <dt>Storage Root</dt>
          <dd>
            <code>{storageStatus?.root ?? `\\wsl.localhost\\MC-Manager-OS\\server`}</code>
          </dd>
          <dt>Engine Status</dt>
          <dd>{provision?.state === "distro_ready" ? "WSL Distro Ready" : provision?.state ?? "Unknown"}</dd>
          <dt>Process PID</dt>
          <dd>{server.pid ? <code>{server.pid}</code> : "Not Running"}</dd>
          <dt>Created Date</dt>
          <dd>{new Date(server.createdAt).toLocaleString()}</dd>
        </dl>
      </section>

      {/* 5. Danger Zone */}
      <section className="card cfg-panel cfg-panel-danger" aria-labelledby="cfg-danger-title">
        <header className="cfg-head">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <h3 id="cfg-danger-title" style={{ color: "#ef4444" }}>Danger Zone</h3>
          <span className="cfg-desc">Irreversible server actions</span>
        </header>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>Delete this server</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Permanently stops process and deletes all server files, worlds, and settings. This cannot be undone.
            </div>
          </div>
          <button type="button" className="danger" onClick={onDelete}>
            Delete Server
          </button>
        </div>
      </section>

      {/* Sticky Save Bar (Appears when there are unsaved changes) */}
      {isDirty && (
        <aside className="cfg-save-bar" role="alert">
          <div className="cfg-save-bar-info">
            <span className="codicon codicon-info" aria-hidden="true" style={{ color: "var(--accent)" }} />
            <span>Careful — you have unsaved configuration changes!</span>
          </div>
          <div className="cfg-save-bar-actions">
            <button
              type="button"
              className="ghost"
              disabled={saving || isRunning}
              onClick={resetForm}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={saving || isRunning}
              onClick={() => void saveConfig()}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
