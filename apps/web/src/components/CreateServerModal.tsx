import { useState } from "react";
import type { JavaVersion, ServerType } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "./Feedback";
import { Modal } from "./Modal";

interface HardwarePreset {
  id: string;
  name: string;
  memoryMb: number;
  cpuCores: number;
  label: string;
}

const HARDWARE_PRESETS: HardwarePreset[] = [
  { id: "light", name: "Light", memoryMb: 1024, cpuCores: 1, label: "1G • 1C" },
  { id: "standard", name: "Standard", memoryMb: 2048, cpuCores: 2, label: "2G • 2C" },
  { id: "performance", name: "Perf", memoryMb: 4096, cpuCores: 4, label: "4G • 4C" },
  { id: "heavy", name: "Heavy", memoryMb: 8192, cpuCores: 6, label: "8G • 6C" },
];

const SUGGESTED_NAMES = ["survival-smp", "creative-realm", "hardcore-world"];

export function CreateServerModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [serverType, setServerType] = useState<ServerType>("java");
  const [name, setName] = useState("");
  const [gamePort, setGamePort] = useState("");
  const [memoryMb, setMemoryMb] = useState("2048");
  const [cpuCores, setCpuCores] = useState("2");
  const [javaVersion, setJavaVersion] = useState<JavaVersion>("17");
  const [optimizeHeavyModpack, setOptimizeHeavyModpack] = useState(true);
  const [acceptEula, setAcceptEula] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBedrock = serverType === "bedrock";

  const activePreset = HARDWARE_PRESETS.find(
    (p) => String(p.memoryMb) === memoryMb && String(p.cpuCores) === cpuCores,
  )?.id;

  function applyPreset(preset: HardwarePreset) {
    setMemoryMb(String(preset.memoryMb));
    setCpuCores(String(preset.cpuCores));
  }

  function handleSelectEdition(type: ServerType) {
    setServerType(type);
    if (type === "bedrock") {
      if (!gamePort || gamePort === "25565") setGamePort("19132");
      if (memoryMb === "2048" && cpuCores === "2") {
        setMemoryMb("1024");
        setCpuCores("1");
      }
    } else {
      if (!gamePort || gamePort === "19132") setGamePort("25565");
      if (memoryMb === "1024" && cpuCores === "1") {
        setMemoryMb("2048");
        setCpuCores("2");
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setBusy(true);
    setError(null);
    try {
      await api.createServer({
        name: name.trim(),
        serverType,
        gamePort: gamePort ? Number(gamePort) : isBedrock ? 19132 : 25565,
        memoryMb: memoryMb ? Number(memoryMb) : undefined,
        cpuCores: cpuCores ? Number(cpuCores) : undefined,
        javaVersion: isBedrock ? undefined : javaVersion,
        optimizeHeavyModpack,
        acceptEula: !isBedrock ? acceptEula : undefined,
      });
      onCreated();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  const memNum = Number(memoryMb) || 0;
  const memGbStr = memNum >= 1024 ? `${(memNum / 1024).toFixed(1)} GB` : `${memNum} MB`;

  return (
    <Modal ariaLabel="Create server" className="modal-create-server" onClose={onClose}>
      <form onSubmit={submit}>
        {/* --- Header --- */}
        <div className="csm-header">
          <div className="csm-header-left">
            <div className="csm-header-icon">
              <span className="codicon codicon-add" aria-hidden="true" />
            </div>
            <div>
              <h2 className="csm-title">Create New Minecraft Server</h2>
              <div className="csm-subtitle">
                Configure container limits, edition, and networking
              </div>
            </div>
          </div>
          <button
            type="button"
            className="csm-close-btn"
            onClick={onClose}
            title="Close dialog (Escape)"
          >
            <span className="codicon codicon-close" />
          </button>
        </div>

        {/* --- 2-Column Responsive Body (Fits inside 90vh) --- */}
        <div className="csm-cols">
          {/* Column 1: Edition, Identity & Runtime */}
          <div className="csm-col">
            {/* 1. Edition */}
            <div className="csm-section">
              <span className="csm-section-title">
                <span className="codicon codicon-package" /> 1. Edition
              </span>
              <div className="csm-edition-grid">
                <div
                  className={`csm-edition-card java ${!isBedrock ? "selected" : ""}`}
                  onClick={() => handleSelectEdition("java")}
                  role="button"
                  tabIndex={0}
                >
                  <div className="csm-edition-top">
                    <div className="csm-edition-icon-wrap">
                      <span className="codicon codicon-coffee" />
                    </div>
                    <div className="csm-edition-radio">
                      {!isBedrock && <div className="csm-edition-radio-inner" />}
                    </div>
                  </div>
                  <div>
                    <div className="csm-edition-name">Java Edition</div>
                    <div className="csm-edition-desc">Paper, Forge, Fabric</div>
                  </div>
                  <div className="csm-edition-tag">Port 25565 • TCP</div>
                </div>

                <div
                  className={`csm-edition-card bedrock ${isBedrock ? "selected" : ""}`}
                  onClick={() => handleSelectEdition("bedrock")}
                  role="button"
                  tabIndex={0}
                >
                  <div className="csm-edition-top">
                    <div className="csm-edition-icon-wrap">
                      <span className="codicon codicon-game" />
                    </div>
                    <div className="csm-edition-radio">
                      {isBedrock && <div className="csm-edition-radio-inner" />}
                    </div>
                  </div>
                  <div>
                    <div className="csm-edition-name">Bedrock</div>
                    <div className="csm-edition-desc">Mobile, Console, Win</div>
                  </div>
                  <div className="csm-edition-tag">Port 19132 • UDP</div>
                </div>
              </div>
            </div>

            {/* 2. Identity & Port */}
            <div className="csm-section">
              <span className="csm-section-title">
                <span className="codicon codicon-tag" /> 2. Server Identity
              </span>
              <div className="csm-grid-2">
                <div className="csm-field">
                  <label className="csm-field-label">Name</label>
                  <div className="csm-input-wrap">
                    <span className="codicon codicon-bookmark csm-input-icon" />
                    <input
                      className="csm-input"
                      autoFocus
                      value={name}
                      placeholder={isBedrock ? "my-bedrock-server" : "my-java-smp"}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="csm-chips">
                    <span className="csm-chip-label">Quick:</span>
                    {SUGGESTED_NAMES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        className="csm-chip"
                        onClick={() => setName(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="csm-field">
                  <label className="csm-field-label">
                    <span>Port</span>
                    <span className="muted" style={{ fontSize: "10.5px" }}>
                      {isBedrock ? "UDP" : "TCP"}
                    </span>
                  </label>
                  <div className="csm-input-wrap">
                    <span className="codicon codicon-globe csm-input-icon" />
                    <input
                      className="csm-input"
                      type="number"
                      value={gamePort}
                      placeholder={isBedrock ? "19132" : "25565"}
                      onChange={(e) => setGamePort(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Java Runtime Version or Bedrock info */}
            {!isBedrock ? (
              <div className="csm-section">
                <span className="csm-section-title">
                  <span className="codicon codicon-tools" /> 3. Java Version
                </span>
                <div className="csm-version-group">
                  <button
                    type="button"
                    className={`csm-version-btn ${javaVersion === "21" ? "active" : ""}`}
                    onClick={() => setJavaVersion("21")}
                  >
                    <span className="csm-version-title">Java 21</span>
                    <span className="csm-version-desc">1.20.5+</span>
                  </button>

                  <button
                    type="button"
                    className={`csm-version-btn ${javaVersion === "17" ? "active" : ""}`}
                    onClick={() => setJavaVersion("17")}
                  >
                    <span className="csm-version-title">Java 17</span>
                    <span className="csm-version-desc">1.18 - 1.20.4</span>
                  </button>

                  <button
                    type="button"
                    className={`csm-version-btn ${javaVersion === "8" ? "active" : ""}`}
                    onClick={() => setJavaVersion("8")}
                  >
                    <span className="csm-version-title">Java 8</span>
                    <span className="csm-version-desc">&le; 1.12.2</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="csm-bedrock-banner">
                <span className="codicon codicon-info" style={{ fontSize: "15px" }} />
                <div>
                  <strong>Native Bedrock Binary:</strong> C++ executable. No Java runtime required.
                </div>
              </div>
            )}
          </div>

          {/* Column 2: Hardware Resources & Optimizations */}
          <div className="csm-col">
            {/* 4. Hardware Resources */}
            <div className="csm-section">
              <div className="csm-field-label">
                <span className="csm-section-title">
                  <span className="codicon codicon-server" /> 4. Resources
                </span>
                <span className="muted" style={{ fontSize: "10.5px" }}>
                  {memGbStr} • {cpuCores || "1"} Core{Number(cpuCores) > 1 ? "s" : ""}
                </span>
              </div>

              {/* Presets */}
              <div className="csm-preset-grid">
                {HARDWARE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`csm-preset-btn ${activePreset === preset.id ? "active" : ""}`}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="csm-preset-name">{preset.name}</span>
                    <span className="csm-preset-specs">{preset.label}</span>
                  </button>
                ))}
              </div>

              {/* Manual input */}
              <div className="csm-grid-2">
                <div className="csm-field">
                  <label className="csm-field-label">
                    <span>RAM (MB)</span>
                    <span className="muted" style={{ fontSize: "10px" }}>{memGbStr}</span>
                  </label>
                  <div className="csm-input-wrap">
                    <span className="codicon codicon-chip csm-input-icon" />
                    <input
                      className="csm-input"
                      type="number"
                      value={memoryMb}
                      step={256}
                      min={512}
                      placeholder="2048"
                      onChange={(e) => setMemoryMb(e.target.value)}
                    />
                  </div>
                </div>

                <div className="csm-field">
                  <label className="csm-field-label">
                    <span>CPU Cores</span>
                    <span className="muted" style={{ fontSize: "10px" }}>Dedicated</span>
                  </label>
                  <div className="csm-input-wrap">
                    <span className="codicon codicon-pulse csm-input-icon" />
                    <input
                      className="csm-input"
                      type="number"
                      value={cpuCores}
                      min={1}
                      max={32}
                      placeholder="2"
                      onChange={(e) => setCpuCores(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* 5. Optimizations & Policies */}
            <div className="csm-section">
              <span className="csm-section-title">
                <span className="codicon codicon-settings-gear" /> 5. Optimizations
              </span>
              <div className="csm-toggle-list">
                {!isBedrock && (
                  <div
                    className="csm-toggle-card"
                    onClick={() => setAcceptEula(!acceptEula)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className={`csm-switch ${acceptEula ? "active" : ""}`}>
                      <div className="csm-switch-handle" />
                    </div>
                    <div className="csm-toggle-content">
                      <div className="csm-toggle-title">Auto-Accept EULA (eula.txt)</div>
                      <div className="csm-toggle-desc">
                        Creates <code>eula.txt</code> with <code>eula=true</code> to avoid startup crash.
                      </div>
                    </div>
                  </div>
                )}

                <div
                  className="csm-toggle-card"
                  onClick={() => setOptimizeHeavyModpack(!optimizeHeavyModpack)}
                  role="button"
                  tabIndex={0}
                >
                  <div className={`csm-switch ${optimizeHeavyModpack ? "active" : ""}`}>
                    <div className="csm-switch-handle" />
                  </div>
                  <div className="csm-toggle-content">
                    <div className="csm-toggle-title">Unlock File Limits (ulimit -n 65535)</div>
                    <div className="csm-toggle-desc">
                      Prevents container descriptor exhaustion for heavy modpacks.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <ErrorText message={error} />

        {/* --- Footer --- */}
        <div className="csm-footer">
          <div className="csm-summary-chip">
            <span className="codicon codicon-info" />
            <span>
              {isBedrock ? "Bedrock" : `Java ${javaVersion}`} &bull; {memGbStr} &bull; {cpuCores || "1"}C &bull; Port {gamePort || (isBedrock ? "19132" : "25565")}
            </span>
          </div>

          <div className="csm-footer-actions">
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="csm-submit-btn"
              disabled={busy || !name.trim()}
            >
              {busy ? (
                <>
                  <span className="codicon codicon-sync spin" />
                  <span>Creating...</span>
                </>
              ) : (
                <>
                  <span className="codicon codicon-plus" />
                  <span>Create Server</span>
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
