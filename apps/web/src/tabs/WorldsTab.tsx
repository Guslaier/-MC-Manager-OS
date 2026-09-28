import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GamerulesView } from "@mcm/contracts";
import { api, describeError } from "../api";
import { Banner, ErrorText } from "../components/Feedback";
import { formatBytes } from "../lib/format";
import { runUpload } from "../lib/uploadManager";

/**
 * Worlds tab: vanilla gamerule catalog read from the world's level.dat,
 * along with world management actions (Download, Upload, Files, Generate).
 * When no world exists (level.dat absent), editing gamerules is strictly disabled.
 */

type GameruleEdits = Record<string, boolean | number>;

export function WorldsTab({
  serverId,
  running,
  onNavigateTab,
}: {
  serverId: string;
  running: boolean;
  onNavigateTab?: (tab: "files") => void;
}) {
  const [view, setView] = useState<GamerulesView | null>(null);
  const [edits, setEdits] = useState<GameruleEdits>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.gamerules(serverId);
      setView(data);
      setEdits({});
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rules = view?.rules ?? [];
  const editCount = Object.keys(edits).length;
  const hasWorld = view?.source === "file";
  const isBedrock = view?.serverType === "bedrock";
  const worldName = view?.levelName || (isBedrock ? "Bedrock level" : "world");
  const targetFolder = view?.worldPath || (isBedrock ? `worlds/${worldName}` : worldName);
  const disabled = (running && !isBedrock) || busy || loading || !hasWorld;
  const canSave = (!running || isBedrock) && !busy && !loading && hasWorld && editCount > 0;

  function toggle(name: string, value: boolean) {
    if (!hasWorld) return;
    setEdits((prev) => ({ ...prev, [name]: value }));
  }

  function setNumber(name: string, raw: string) {
    if (!hasWorld) return;
    const next = Number(raw);
    setEdits((prev) => ({ ...prev, [name]: Number.isFinite(next) ? Math.trunc(next) : 0 }));
  }

  function valueOf(name: string, original: boolean | number): boolean | number {
    return name in edits ? edits[name] : original;
  }

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateGamerules(serverId, edits);
      setView(res.gamerules);
      setEdits({});
      setNotice(res.changed.length ? `saved: ${res.changed.join(", ")}` : "no changes on disk");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function flush() {
    if (!running || busy) return;
    if (!window.confirm(`Flush world saves for ${serverId}?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.flushWorld(serverId);
      setNotice(`world flush sent: ${res.command}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  // --- World Actions: Download, Upload, Files, Generate ---

  async function handleDownload() {
    if (!hasWorld || busy) return;
    setBusy(true);
    setBusyAction("Preparing world download...");
    setError(null);
    setNotice(`Preparing ${worldName}.zip...`);
    try {
      const res = await api.downloadWorld(serverId);
      if (!res.ok) {
        let msg = `Download failed (HTTP ${res.status})`;
        try {
          const text = await res.text();
          const json = JSON.parse(text);
          if (json.message) msg = json.message;
        } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${worldName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${worldName}.zip (${formatBytes(blob.size)}).`);
    } catch (err) {
      setError(describeError(err));
      setNotice(null);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  function triggerUpload() {
    if (running) {
      setError("Stop the server before uploading a world.");
      return;
    }
    fileInputRef.current?.click();
  }

  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    if (running) {
      setError("Stop the server before uploading a world.");
      return;
    }

    if (hasWorld) {
      const ok = window.confirm(
        `Uploading a world will replace the current world folder ('${worldName}'). Do you want to continue?`
      );
      if (!ok) return;
    }

    setBusy(true);
    setBusyAction(`Uploading ${file.name}...`);
    setError(null);
    setNotice(null);

    const controller = new AbortController();

    try {
      // 1. Upload chunked to server directory
      await runUpload({
        file,
        dirPath: serverId,
        serverId,
        policy: "replace",
        resumeFrom: 0,
        signal: controller.signal,
        onProgress: (uploaded) => {
          const pct = Math.round((uploaded / file.size) * 100);
          setBusyAction(`Uploading ${file.name} (${pct}%)...`);
        },
      });

      // 2. Import and extract archive into world folder
      setBusyAction("Extracting and verifying world files...");
      const result = await api.importWorld(serverId, `${serverId}/${file.name}`);

      setNotice(`World '${file.name}' imported successfully into '${result.levelName}'.`);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleDeleteWorld() {
    if (running) {
      setError("Stop the server before deleting the world.");
      return;
    }
    if (!hasWorld) return;

    const ok = window.confirm(
      `Are you sure you want to permanently delete world '${targetFolder}'? All world data and progress will be lost.`
    );
    if (!ok) return;

    setBusy(true);
    setBusyAction("Deleting world...");
    setError(null);
    setNotice(null);

    try {
      await api.deleteWorld(serverId);
      setNotice(`World '${targetFolder}' deleted successfully.`);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  const counts = useMemo(() => {
    const bools = rules.filter((rule) => rule.type === "boolean").length;
    return { bools, ints: rules.length - bools };
  }, [rules]);

  return (
    <div className="pw-view">
      {/* Hidden file input for uploading world archive */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.tar,.gz,.tgz"
        style={{ display: "none" }}
        onChange={(e) => void handleUploadFile(e)}
      />

      {/* World Management Actions Panel */}
      <section className="card pw-panel world-actions-panel" aria-label="World Actions">
        <header className="pw-head">
          <span className="codicon codicon-globe" aria-hidden="true" />
          <h2>World Management</h2>
          <span className="pw-meta">
            Target folder: <code>{targetFolder}</code> (level-name: <code>{worldName}</code>) · Status:{" "}
            {loading ? "checking..." : hasWorld ? "Available" : "No World Generated"}
          </span>
        </header>

        <div className="world-actions-body">
          <div className="world-btn-group">
            {/* 1. Download Button */}
            <button
              type="button"
              className="world-btn world-btn-download"
              disabled={!hasWorld || busy || loading}
              title={
                !hasWorld
                  ? "No world exists to download"
                  : `Download ${targetFolder} folder as a ZIP archive`
              }
              onClick={() => void handleDownload()}
            >
              <span className="codicon codicon-cloud-download" aria-hidden="true" />
              <span>Download</span>
            </button>

            {/* 2. Upload Button */}
            <button
              type="button"
              className="world-btn world-btn-upload"
              disabled={busy || loading || running}
              title={
                running
                  ? "Stop server before uploading world"
                  : "Upload a world ZIP or archive into this server"
              }
              onClick={triggerUpload}
            >
              <span className="codicon codicon-cloud-upload" aria-hidden="true" />
              <span>Upload</span>
            </button>

            {/* 3. Delete Button */}
            <button
              type="button"
              className="world-btn world-btn-delete"
              disabled={!hasWorld || busy || loading || running}
              title={
                running
                  ? "Stop server before deleting world"
                  : !hasWorld
                    ? "No world exists to delete"
                    : `Permanently delete world folder '${targetFolder}'`
              }
              onClick={() => void handleDeleteWorld()}
            >
              <span className="codicon codicon-trash" aria-hidden="true" />
              <span>Delete</span>
            </button>
          </div>

          {busyAction && (
            <div className="world-busy-indicator" role="status">
              <span className="codicon codicon-loading spin" aria-hidden="true" />
              <span>{busyAction}</span>
            </div>
          )}

          {error && <ErrorText message={error} />}
          {notice && <p className="pw-notice">{notice}</p>}
        </div>
      </section>

      {/* World Gamerules Card */}
      <section className="card pw-panel" aria-labelledby="worlds-title">
        <header className="pw-head">
          <span className="codicon codicon-settings" aria-hidden="true" />
          <h2 id="worlds-title">World Gamerules</h2>
          {(() => {
            const metaText = view
              ? `level: ${view.levelName ?? worldName} · ${rules.length} rule(s) · ${
                  hasWorld ? "read from level.dat" : "vanilla defaults (no world)"
                }${view.reason ? ` · ${view.reason}` : ""}`
              : "loading gamerules";
            return (
              <span className="pw-meta" title={metaText}>
                {metaText}
              </span>
            );
          })()}
          <span className="spacer" />
          <button
            className="pw-iconbtn"
            type="button"
            disabled={loading || busy}
            title="Reload gamerules from level.dat (discards pending edits)"
            aria-label="Reload gamerules"
            onClick={() => void load()}
          >
            <span className="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button
            className="pw-iconbtn"
            type="button"
            disabled={!running || busy}
            title={running ? "Flush world saves (asks to confirm)" : "Server is stopped"}
            aria-label="Flush world save"
            onClick={() => void flush()}
          >
            <span className="codicon codicon-save" aria-hidden="true" />
          </button>
        </header>

        {/* Notice banners */}
        {!loading && !hasWorld && (
          <Banner>
            No world exists yet for this server. Start the server to generate one, or upload a world archive above. Gamerule editing is disabled until a world is generated.
          </Banner>
        )}

        {running && !isBedrock && (
          <Banner>
            Server is running — stop it to save gamerules. The backend rejects PATCH (409 server_running) until the server is stopped; Reload still works.
          </Banner>
        )}

        {running && isBedrock && (
          <Banner>
            🎮 Bedrock Server กำลังทำงาน — ปรับแต่ง Gamerules ได้ทันทีผ่าน GUI และมีผลในเกมแบบเรียลไทม์
          </Banner>
        )}

        <ErrorText message={error} />
        {notice ? <p className="pw-notice">{notice}</p> : null}

        {view === null ? (
          <p className="muted">{loading ? "Loading gamerules..." : "Gamerules unavailable."}</p>
        ) : rules.length === 0 ? (
          <p className="muted">No gamerules in the catalog. {view.reason ?? ""}</p>
        ) : (
          <div className={`rule-grid${!hasWorld ? " rule-grid-disabled" : ""}`}>
            {rules.map((rule) => {
              const value = valueOf(rule.name, rule.value);
              if (rule.type === "boolean") {
                return (
                  <label
                    className={`rule-row${!hasWorld ? " disabled" : ""}`}
                    key={rule.name}
                    title={
                      !hasWorld
                        ? "World does not exist yet. Editing disabled."
                        : rule.description
                    }
                  >
                    <input
                      type="checkbox"
                      checked={value === true}
                      disabled={disabled}
                      onChange={(event) => toggle(rule.name, event.target.checked)}
                    />
                    <span className="rule-name">{rule.name}</span>
                    <span className="pw-src">{hasWorld ? rule.source : "default"}</span>
                  </label>
                );
              }
              return (
                <label
                  className={`rule-row${!hasWorld ? " disabled" : ""}`}
                  key={rule.name}
                  title={
                    !hasWorld
                      ? "World does not exist yet. Editing disabled."
                      : rule.description
                  }
                >
                  <span className="rule-name">{rule.name}</span>
                  <input
                    type="number"
                    step={1}
                    value={typeof value === "number" ? value : 0}
                    disabled={disabled}
                    onChange={(event) => setNumber(rule.name, event.target.value)}
                  />
                  <span className="pw-src">{hasWorld ? rule.source : "default"}</span>
                </label>
              );
            })}
          </div>
        )}

        <footer className="pw-foot">
          <span className="pw-foot-count" role="status" aria-live="polite">
            {counts.bools} boolean · {counts.ints} integer{editCount ? ` · ${editCount} unsaved` : ""}
            {!hasWorld && !loading ? " · (editing disabled: no world)" : ""}
          </span>
          <span className="spacer" />
          <button
            type="button"
            disabled={!canSave}
            title={
              !hasWorld
                ? "Generate or upload a world first before saving gamerules"
                : running && !isBedrock
                  ? "Stop the server first"
                  : editCount === 0
                    ? "No pending changes"
                    : "Write gamerules"
            }
            onClick={() => void save()}
          >
            {!hasWorld
              ? "No world to save"
              : running && !isBedrock
                ? "Stop server to save"
                : "Save changes"}
          </button>
        </footer>
      </section>
    </div>
  );
}
