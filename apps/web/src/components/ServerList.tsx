import { useCallback, useEffect, useState } from "react";
import type { ContainerMetrics, EngineProbe, ServerRecord } from "@mcm/contracts";
import { api, describeError, type LifecycleAction } from "../api";
import { UsageBar } from "./UsageBar";
import { StateBadge } from "./StateBadge";
import { Banner, ErrorText } from "./Feedback";
import { ServerDashboard, type ServerFilterType } from "./ServerDashboard";

/**
 * Maps a server state onto a badge tone. `created` has no dedicated style, so it
 * reads as the neutral muted pill - the label still shows the real state verbatim.
 */
function toneFor(state: ServerRecord["state"]): "running" | "stopped" | "muted" {
  if (state === "running") return "running";
  if (state === "stopped") return "stopped";
  return "muted";
}

/** View 1: the server table. The create-server modal is owned by the overview page. */
export function ServerList({
  servers,
  error,
  engine,
  onOpen,
  onChanged,
  onError,
  onCreate,
}: {
  servers: ServerRecord[];
  error: string | null;
  engine: EngineProbe | null;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onError: (msg: string | null) => void;
  onCreate: () => void;
}) {
  const [metrics, setMetrics] = useState<Record<string, ContainerMetrics>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ServerFilterType>("all");
  const [search, setSearch] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Sample every server; a stopped server honestly reports source "declared".
  const sampleAll = useCallback(async () => {
    const results = await Promise.all(
      servers.map(async (s) => {
        try {
          return [s.id, await api.metrics(s.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    const next: Record<string, ContainerMetrics> = {};
    for (const r of results) if (r) next[r[0]] = r[1];
    setMetrics(next);
  }, [servers]);

  useEffect(() => {
    if (servers.length > 0) sampleAll().catch(() => undefined);
  }, [servers, sampleAll]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await sampleAll();
      onChanged();
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  async function act(s: ServerRecord, action: LifecycleAction) {
    if (action === "kill" && !confirm("Force kill this server? Unsaved world data may be lost.")) return;
    setBusyId(s.id);
    onError(null);
    try {
      await api.lifecycle(s.id, action);
    } catch (err) {
      // Honest failure, e.g. start -> 503 engine_unavailable with the real reason.
      onError(describeError(err));
    } finally {
      setBusyId(null);
      onChanged();
    }
  }

  const filteredServers = servers.filter((s) => {
    if (filter === "running" && s.state !== "running") return false;
    if (filter === "stopped" && s.state === "running") return false;
    if (filter === "java" && s.serverType === "bedrock") return false;
    if (filter === "bedrock" && s.serverType !== "bedrock") return false;

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchName = s.name.toLowerCase().includes(q);
      const matchPort = String(s.gamePort).includes(q);
      const matchType = (s.serverType ?? "java").toLowerCase().includes(q);
      const matchSoftware = (s.jarFile ?? "").toLowerCase().includes(q);
      if (!matchName && !matchPort && !matchType && !matchSoftware) return false;
    }
    return true;
  });

  return (
    <section>
      <ServerDashboard
        servers={servers}
        metrics={metrics}
        engine={engine}
        activeFilter={filter}
        searchQuery={search}
        onFilterChange={setFilter}
        onSearchChange={setSearch}
        onRefresh={handleRefresh}
        onCreate={onCreate}
        isRefreshing={isRefreshing}
      />

      {engine && !engine.available && (
        <Banner>
          Lifecycle refused: {engine.reason}
          {engine.runtimePath ? ` (runtime: ${engine.runtimePath})` : ""}
        </Banner>
      )}
      <ErrorText message={error} />

      {servers.length === 0 ? (
        <p className="muted">No servers yet. Create one to get started.</p>
      ) : filteredServers.length === 0 ? (
        <div className="panel" style={{ padding: "36px", textAlign: "center" }}>
          <span className="codicon codicon-search" style={{ fontSize: "32px", color: "var(--muted)", opacity: 0.5 }} />
          <p style={{ marginTop: "12px", marginBottom: "16px", color: "var(--text-dim)" }}>
            No servers matching "{search}" or selected filter.
          </p>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setFilter("all");
              setSearch("");
            }}
          >
            Clear Filters
          </button>
        </div>
      ) : (
        <div className="panel">
          <table className="grid servers-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Name</th>
                <th>Port</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>Edition / Software</th>
                <th>Controls</th>
              </tr>
            </thead>
            <tbody>
              {filteredServers.map((s) => {
                const m = metrics[s.id];
                const rawCpu = m?.cpuPercent ?? null;
                const cores = Math.max(1, s.cpuCores || 1);
                const cpuPct = rawCpu !== null
                  ? (rawCpu > 100 ? Math.min(100, Math.round((rawCpu / cores) * 10) / 10) : rawCpu)
                  : null;
                const ramUsed = m?.memoryMb ?? null;
                const ramLimit = m?.memoryLimitMb ?? s.memoryMb;
                const ramPct = ramUsed !== null && ramLimit > 0 ? (ramUsed / ramLimit) * 100 : 0;
                const isBedrock = s.serverType === "bedrock";
                return (
                  <tr key={s.id}>
                    <td>
                      <StateBadge tone={toneFor(s.state)} label={s.state} />
                    </td>
                    <td>
                      <button className="link name" onClick={() => onOpen(s.id)}>
                        {s.name}
                      </button>
                    </td>
                    <td>{s.gamePort}</td>
                    <td>
                      <UsageBar
                        label={cpuPct === null ? `${s.cpuCores} cores` : `${Math.round(cpuPct)}% of ${s.cpuCores} cores`}
                        percent={cpuPct === null ? 0 : cpuPct}
                        tone={cpuPct === null ? "muted" : "cpu"}
                      />
                    </td>
                    <td>
                      <UsageBar
                        label={ramUsed === null ? `limit ${ramLimit} MB` : `${ramUsed} / ${ramLimit} MB`}
                        percent={ramPct}
                        tone={ramUsed === null ? "muted" : "ram"}
                      />
                    </td>
                    <td>
                      {isBedrock ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "2px 7px",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: 600,
                              background: "rgba(56, 189, 248, 0.12)",
                              color: "#38bdf8",
                              border: "1px solid rgba(56, 189, 248, 0.25)",
                            }}
                          >
                            <span className="codicon codicon-game" style={{ fontSize: "12px" }} />
                            Bedrock
                          </span>
                          <span className="muted" style={{ fontSize: "12px" }}>
                            {s.jarFile ?? "bedrock_server"} (Native)
                          </span>
                        </div>
                      ) : (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              padding: "2px 7px",
                              borderRadius: "4px",
                              fontSize: "11px",
                              fontWeight: 600,
                              background: "rgba(245, 158, 11, 0.12)",
                              color: "#f59e0b",
                              border: "1px solid rgba(245, 158, 11, 0.25)",
                            }}
                          >
                            <span className="codicon codicon-coffee" style={{ fontSize: "12px" }} />
                            Java {s.javaVersion}
                          </span>
                          <span className="muted" style={{ fontSize: "12px" }}>
                            {s.jarFile ?? "server.jar"}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="actions">
                      {s.state !== "running" ? (
                        <button
                          disabled={busyId === s.id || !s.jarFile}
                          title={!s.jarFile ? (isBedrock ? "No bedrock_server executable found" : "No launch jar selected") : undefined}
                          onClick={() => act(s, "start")}
                        >
                          Start
                        </button>
                      ) : (
                        <button disabled={busyId === s.id} onClick={() => act(s, "stop")}>
                          Stop
                        </button>
                      )}
                      <button disabled={busyId === s.id} onClick={() => act(s, "restart")}>
                        Restart
                      </button>
                      <button
                        className="danger"
                        disabled={busyId === s.id || s.state !== "running"}
                        onClick={() => act(s, "kill")}
                      >
                        Kill
                      </button>
                      <button onClick={() => onOpen(s.id)}>Manage</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
