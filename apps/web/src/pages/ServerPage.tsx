import { useEffect, useState } from "react";
import type { ContainerMetrics, EngineProbe, EulaStatus, ProvisionReport, ServerRecord } from "@mcm/contracts";
import { api, describeError, type LifecycleAction } from "../api";
import { UsageBar } from "../components/UsageBar";
import { StateBadge } from "../components/StateBadge";
import { Banner, ErrorText } from "../components/Feedback";
import { ConsoleTab } from "../tabs/ConsoleTab";
import { FilesTab } from "../tabs/FilesTab";
import { ConfigTab } from "../tabs/ConfigTab";
import { PropertiesTab } from "../tabs/PropertiesTab";
import { WorldsTab } from "../tabs/WorldsTab";
import { PlayersTab } from "../tabs/PlayersTab";
import { describeStorage } from "../lib/format";

type ServerTab = "console" | "files" | "config" | "properties" | "worlds" | "players";

/** Sub-navigation labels; keeps the nav render free of nested ternaries. */
const TAB_LABELS: Record<ServerTab, string> = {
  console: "Live Console",
  files: "File Manager",
  config: "Configuration",
  properties: "Properties",
  worlds: "Worlds",
  players: "Players",
};

/** View 2: one server, its power controls and the per-server tabs. */
export function ServerPage({
  server,
  engine,
  tab,
  onTab,
  onChanged,
  onDeleted,
}: {
  server: ServerRecord;
  engine: EngineProbe | null;
  tab: ServerTab;
  onTab: (tab: ServerTab) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [provision, setProvision] = useState<ProvisionReport | null>(null);
  const [eulaStatus, setEulaStatus] = useState<EulaStatus | null>(null);
  const [eulaBusy, setEulaBusy] = useState(false);

  const loadEula = () => {
    if (server.serverType === "bedrock") return;
    api
      .getEula(server.id)
      .then(setEulaStatus)
      .catch(() => setEulaStatus(null));
  };

  useEffect(() => {
    let alive = true;
    const tick = () => {
      api
        .metrics(server.id)
        .then((m) => {
          if (alive) setMetrics(m);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [server.id]);

  useEffect(() => {
    api
      .provision()
      .then(setProvision)
      .catch(() => setProvision(null));
    loadEula();
  }, [server.id, server.state]);

  async function act(action: LifecycleAction) {
    if (action === "kill" && !confirm("Force kill this server? Unsaved world data may be lost.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.lifecycle(server.id, action);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      onChanged();
      loadEula();
    }
  }

  async function acceptEula(andStart = false) {
    setEulaBusy(true);
    setError(null);
    try {
      if (andStart) {
        await api.lifecycle(server.id, "start", { acceptEula: true });
        onChanged();
      } else {
        await api.setEula(server.id, true);
      }
      loadEula();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setEulaBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete ${server.name}? Its process is stopped and its data directory removed. This cannot be undone.`))
      return;
    setError(null);
    try {
      await api.deleteServer(server.id);
      onDeleted();
    } catch (err) {
      setError(describeError(err));
    }
  }

  const rawCpu = metrics?.cpuPercent ?? null;
  const cores = Math.max(1, server.cpuCores || 1);
  const cpuPct = rawCpu !== null
    ? (rawCpu > 100 ? Math.min(100, Math.round((rawCpu / cores) * 10) / 10) : rawCpu)
    : null;
  const ramPct =
    metrics?.memoryMb != null && metrics.memoryLimitMb > 0
      ? (metrics.memoryMb / metrics.memoryLimitMb) * 100
      : 0;
  // Real storage bytes from the metrics walk/statfs sample, or an honest unavailable label.
  const storage = describeStorage(metrics);

  return (
    <section>
      <div className="server-head">
        <div className="row">
          <StateBadge
            tone={server.state === "running" ? "running" : server.state === "stopped" ? "stopped" : "muted"}
            label={server.state}
          />
          <h1>{server.name}</h1>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              fontSize: "12px",
              fontWeight: 600,
              background: server.serverType === "bedrock" ? "rgba(56, 189, 248, 0.15)" : "rgba(245, 158, 11, 0.15)",
              color: server.serverType === "bedrock" ? "#38bdf8" : "#f59e0b",
              border: `1px solid ${server.serverType === "bedrock" ? "rgba(56, 189, 248, 0.3)" : "rgba(245, 158, 11, 0.3)"}`,
            }}
          >
            {server.serverType === "bedrock" ? "Bedrock Edition" : "Java Edition"}
          </span>
          <span className="muted">port {server.gamePort}</span>
        </div>
        <div className="row power">
          {server.state !== "running" ? (
            <button
              disabled={busy || (!server.jarFile && server.serverType !== "bedrock")}
              title={!server.jarFile && server.serverType !== "bedrock" ? "Select a Core jar in Configuration before starting" : undefined}
              onClick={() => act("start")}
            >
              Start
            </button>
          ) : (
            <button disabled={busy} onClick={() => act("stop")}>
              Stop
            </button>
          )}
          <button disabled={busy} onClick={() => act("restart")}>
            Restart
          </button>
          <button className="danger" disabled={busy || server.state !== "running"} onClick={() => act("kill")}>
            Kill
          </button>
        </div>
      </div>

      {engine && !engine.available && <Banner>Lifecycle refused: {engine.reason}</Banner>}
      {eulaStatus?.state === "declined" && server.serverType !== "bedrock" && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            background: "rgba(245, 158, 11, 0.12)",
            border: "1px solid rgba(245, 158, 11, 0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
            marginBottom: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span className="codicon codicon-warning" style={{ color: "#f59e0b", fontSize: "18px" }} />
            <div>
              <div style={{ fontWeight: 600, color: "#f59e0b" }}>Minecraft EULA Required (eula.txt)</div>
              <div style={{ fontSize: "12px", color: "var(--muted)" }}>
                คุณยังไม่ได้ยอมรับ Minecraft EULA ทำให้เซิร์ฟเวอร์ Java ดับหรือไม่เริ่มทำงาน
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              className="ghost"
              disabled={eulaBusy}
              onClick={() => acceptEula(false)}
              style={{ fontSize: "12px", padding: "6px 12px" }}
            >
              {eulaBusy ? "กำลังบันทึก..." : "ยอมรับ EULA"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={eulaBusy || !server.jarFile}
              onClick={() => acceptEula(true)}
              style={{ fontSize: "12px", padding: "6px 12px" }}
            >
              {eulaBusy ? "กำลังเริ่ม..." : "ยอมรับ EULA & เริ่มเซิร์ฟเวอร์"}
            </button>
          </div>
        </div>
      )}
      {!server.jarFile && server.serverType !== "bedrock" && server.state !== "running" && (
        <Banner>
          No launch jar selected. You must pick or upload a Core jar (.jar){" "}
          {tab === "config" ? (
            "under Core & scripts below"
          ) : (
            <>
              in{" "}
              <button type="button" className="banner-link" onClick={() => onTab("config")}>
                Configuration
              </button>
            </>
          )}{" "}
          before the server can run.
        </Banner>
      )}
      <ErrorText message={error} />

      <div className="stat-strip">
        <div className="stat">
          <span className="muted">CPU</span>
          <UsageBar
            label={cpuPct === null ? `${server.cpuCores} cores` : `${Math.round(cpuPct)}% of ${server.cpuCores} cores`}
            percent={cpuPct === null ? 0 : cpuPct}
            tone={cpuPct === null ? "muted" : "cpu"}
          />
        </div>
        <div className="stat">
          <span className="muted">RAM</span>
          <UsageBar
            label={
              metrics?.memoryMb != null
                ? `${metrics.memoryMb} / ${metrics.memoryLimitMb} MB`
                : `limit ${metrics?.memoryLimitMb ?? server.memoryMb} MB`
            }
            percent={ramPct}
            tone={metrics?.memoryMb != null ? "ram" : "muted"}
          />
        </div>
        <div className="stat">
          <span className="muted">PID</span>
          <strong>{server.pid ?? "-"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Sample</span>
          <strong>{metrics?.source ?? "..."}</strong>
        </div>
        <div className="stat">
          <span className="muted">Launch jar</span>
          <strong className={!server.jarFile ? "metric-warn" : undefined}>{server.jarFile ?? "none"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Storage</span>
          <strong
            className={storage.text === "Unavailable (no source)" ? "metric-unavail" : undefined}
            title={storage.title || undefined}
            aria-label={storage.title ? `Storage ${storage.text} — ${storage.title}` : `Storage ${storage.text}`}
          >
            {storage.text}
          </strong>
        </div>
      </div>

      <nav className="subnav">
        {(Object.keys(TAB_LABELS) as ServerTab[]).map((t) => (
          <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => onTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {tab === "console" && <ConsoleTab server={server} metrics={metrics} />}
      {tab === "files" && <FilesTab serverId={server.id} />}
      {tab === "config" && (
        <ConfigTab server={server} provision={provision} onChanged={onChanged} onDelete={remove} />
      )}
      {tab === "properties" && <PropertiesTab serverId={server.id} running={server.state === "running"} />}
      {tab === "worlds" && (
        <WorldsTab serverId={server.id} running={server.state === "running"} onNavigateTab={onTab} />
      )}
      {tab === "players" && <PlayersTab serverId={server.id} running={server.state === "running"} />}
    </section>
  );
}
