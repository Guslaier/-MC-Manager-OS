// Thin orchestrator for the mcm-server console SPA. Owns the session gate, the
// view state machine and the shared server/engine state; the actual surfaces live
// under ./pages, ./tabs and ./components.
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineProbe, ServerRecord, SessionInfo } from "@mcm/contracts";
import { api, describeError, getToken, setToken } from "./api";
import { Topbar } from "./components/Topbar";
import { LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { StatusPage } from "./pages/StatusPage";
import { ServerPage } from "./pages/ServerPage";
// VS Code Codicons font CSS must load before styles.css so app rules win the cascade.
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

type ServerTab = "console" | "files" | "config" | "properties" | "worlds" | "players";

type View =
  | { name: "overview" }
  | { name: "status" }
  | { name: "server"; id: string; tab: ServerTab };

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  // Restore an existing token on load; a rejected token means we show login.
  useEffect(() => {
    if (!getToken()) {
      setChecking(false);
      return;
    }
    api
      .session()
      .then(setSession)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setSession(null);
  }, []);

  if (checking) return <main className="center muted">Checking session...</main>;
  if (!session) return <LoginPage onLogin={setSession} />;
  return <Dashboard session={session} onLogout={logout} />;
}

function Dashboard({ session, onLogout }: { session: SessionInfo; onLogout: () => void }) {
  const [view, setView] = useState<View>({ name: "overview" });
  const [engine, setEngine] = useState<EngineProbe | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Kept in a ref so the status poller does not need to re-subscribe per render.
  const serversRef = useRef(servers);
  serversRef.current = servers;

  const refreshServers = useCallback(() => {
    api
      .servers()
      .then(setServers)
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    api
      .engine()
      .then(setEngine)
      .catch(() => setEngine(null));
  }, []);
  useEffect(refreshServers, [refreshServers]);

  // Poll only while something is actually running - a stopped panel stays quiet.
  useEffect(() => {
    const timer = setInterval(() => {
      if (serversRef.current.some((s) => s.state === "running")) refreshServers();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshServers]);

  const selected = view.name === "server" ? servers.find((s) => s.id === view.id) ?? null : null;

  function goOverview() {
    setView({ name: "overview" });
  }

  return (
    <div className="app">
      <Topbar
        username={session.username}
        section={view.name}
        serverName={selected?.name ?? null}
        onNavigate={(section) => setView(section === "overview" ? { name: "overview" } : { name: "status" })}
        onLogout={onLogout}
      />

      <main className="content">
        {view.name === "overview" && (
          <OverviewPage
            servers={servers}
            error={error}
            engine={engine}
            onOpen={(id) => setView({ name: "server", id, tab: "console" })}
            onChanged={refreshServers}
            onError={setError}
          />
        )}
        {view.name === "status" && <StatusPage engine={engine} />}
        {view.name === "server" &&
          (selected ? (
            <ServerPage
              server={selected}
              engine={engine}
              tab={view.tab}
              onTab={(tab) => setView({ name: "server", id: selected.id, tab })}
              onChanged={refreshServers}
              onDeleted={() => {
                refreshServers();
                goOverview();
              }}
            />
          ) : (
            <div className="card">
              <p className="muted">That server no longer exists.</p>
              <button onClick={goOverview}>Back to servers</button>
            </div>
          ))}
      </main>
    </div>
  );
}
