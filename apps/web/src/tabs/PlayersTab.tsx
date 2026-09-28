import { useEffect, useMemo, useState } from "react";
import type { PlayerAction, PlayerListResult, PlayerRef, WorldStateResult } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "../components/Feedback";
import { StateBadge } from "../components/StateBadge";

/**
 * Players tab: honest, console/file-backed Player & World management. Online players
 * come from the game's own `list` command (the backend sends it and parses the reply);
 * ops/whitelist, world folders and server.properties settings are read from the server's
 * canonical files. Chunk counts now come from a region-header scan and the last save time from
 * the newest region-file mtime; live entity counts and the autosave interval still have no
 * source in this build (no NBT parsing), so only those stay labelled unavailable. Every other
 * value shown is real, and management actions are disabled while the server is stopped.
 * Dimension state and gamerule editing live in the Worlds tab; server.properties lives in Properties.
 */

/** How often the file-backed world state is refreshed; players refresh alongside it while running. */
const POLL_MS = 6000;

/** Where a players row set came from, so the source is never hidden from the operator. */
function sourceLabel(source: PlayerListResult["source"] | undefined): string {
  switch (source) {
    case "console":
      return "source: live console `list`";
    case "files":
      return "source: ops.json / whitelist.json";
    case "none":
      return "no player source readable";
    default:
      return "loading";
  }
}

export function PlayersTab({ serverId, running }: { serverId: string; running: boolean }) {
  const [players, setPlayers] = useState<PlayerListResult | null>(null);
  const [world, setWorld] = useState<WorldStateResult | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [whitelistName, setWhitelistName] = useState("");

  async function loadPlayers() {
    const data = await api.players(serverId);
    setPlayers(data);
  }

  async function loadWorld() {
    const data = await api.world(serverId);
    setWorld(data);
  }

  async function refresh() {
    setError(null);
    try {
      await Promise.all([loadPlayers(), loadWorld()]);
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Poll while mounted: world state is a cheap file read, but players triggers a real
  // `list` console command, so it is only re-run while the server is actually running.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      loadWorld().catch((err) => alive && setError(describeError(err)));
      if (running) loadPlayers().catch((err) => alive && setError(describeError(err)));
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, running]);

  const rows = useMemo(() => {
    const list = players?.players ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((player) => player.name.toLowerCase().includes(needle));
  }, [players, query]);

  const hasPlayers = (players?.players.length ?? 0) > 0;
  const canCommand = running && !busy;

  // Canonical whitelist names: the file on disk (whitelist.json / allowlist.json) merged
  // with live players the server has flagged as whitelisted, so neither source hides the other.
  const whitelistNames = useMemo(() => {
    const fromFile = world?.whitelist ?? [];
    const fromLive = (players?.players ?? []).filter((player) => player.whitelisted).map((player) => player.name);
    return [...new Set([...fromFile, ...fromLive])].sort((a, b) => a.localeCompare(b));
  }, [world, players]);

  const whitelistEnabled = world?.whitelistEnabled ?? null;

  async function runAction(action: PlayerAction, player?: PlayerRef, message?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.playerAction(serverId, {
        action,
        ...(player ? { player: player.name } : {}),
        ...(message ? { message } : {}),
        ...(action === "kick" && player ? { confirm: player.name } : {}),
      });
      setNotice(`${res.action} sent: ${res.command}`);
      await loadPlayers();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function directMessage(player: PlayerRef) {
    const message = window.prompt(`Message to ${player.name}`, "Hello!");
    if (message === null) return;
    if (!message.trim()) {
      setError("message must not be empty");
      return;
    }
    void runAction("say", player, message.trim());
  }

  function kick(player: PlayerRef) {
    if (!window.confirm(`Kick ${player.name}?`)) return;
    void runAction("kick", player);
  }

  /** Add/remove is a live console command, so it needs a running process (same gate as kick/op). */
  async function runWhitelist(action: PlayerAction, name: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.playerAction(serverId, {
        action,
        player: name,
        ...(action === "whitelist-remove" ? { confirm: name } : {}),
      });
      setNotice(`${res.action} sent: ${res.command}`);
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function addWhitelistName() {
    const name = whitelistName.trim();
    if (!name) {
      setError("enter a player name to whitelist");
      return;
    }
    setWhitelistName("");
    void runWhitelist("whitelist-add", name);
  }

  function removeWhitelistName(name: string) {
    if (!window.confirm(`Remove ${name} from the whitelist?`)) return;
    void runWhitelist("whitelist-remove", name);
  }

  /** Enable/disable flips the `white-list` property, which is a stopped-only file edit. */
  async function toggleWhitelistEnabled(next: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateProperties(serverId, { whitelistEnabled: next });
      setNotice(res.changed.length ? `whitelist ${next ? "enabled" : "disabled"}` : "no changes on disk");
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pw-view">
      <section className="card pw-panel" aria-labelledby="pw-session-title">
        <header className="pw-head">
          <span className="codicon codicon-organization" aria-hidden="true" />
          <h2 id="pw-session-title">Active Session</h2>
          <StateBadge tone={running ? "running" : "stopped"} label={running ? "online" : "offline"} />
          <span className="pw-meta">
            server <code>{serverId}</code>
          </span>
          <span className="spacer" />
          <button
            className="pw-iconbtn"
            type="button"
            disabled={busy}
            title="Refresh players and world state"
            aria-label="Refresh online players"
            onClick={() => void refresh()}
          >
            <span className="codicon codicon-refresh" aria-hidden="true" />
          </button>
        </header>

        <div className="pw-toolbar">
          <label className="pw-search">
            <span className="codicon codicon-search" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter players by name"
              aria-label="Filter players by name"
              disabled={players === null}
              title={players ? "Filter the parsed player list" : "Waiting for player data"}
            />
          </label>
          <span className="pw-note" title={players?.raw ?? undefined}>
            {sourceLabel(players?.source)} ·{" "}
            {players?.onlineCount !== null && players?.onlineCount !== undefined
              ? `${players.onlineCount} online of ${players.maxPlayers ?? world?.maxPlayers ?? "?"}`
              : `online count unavailable${running ? "" : " (server stopped)"} · max ${
                  players?.maxPlayers ?? world?.maxPlayers ?? "?"
                }`}
          </span>
        </div>

        <ErrorText message={error} />
        {notice ? <p className="pw-notice">{notice}</p> : null}

        <div className="pw-tablewrap">
          <table className="pw-table">
            <caption className="pw-caption">Online players reported by the server</caption>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Role</th>
                <th scope="col" className="pw-col-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="pw-empty">
                    {hasPlayers
                      ? "No player matches the filter."
                      : running
                        ? "Waiting for the server's `list` reply."
                        : `No players. ${players?.reason ?? "Server is stopped."}`}
                  </td>
                </tr>
              ) : (
                rows.map((player) => (
                  <tr key={player.name}>
                    <td>
                      {player.name}
                      <span className="pw-src"> {player.source}</span>
                    </td>
                    <td>
                      {player.op ? "OP" : "member"}
                      {player.whitelisted ? <span className="pw-badge">whitelisted</span> : null}
                    </td>
                    <td className="pw-col-actions">
                      <button
                        className="pw-action"
                        type="button"
                        disabled={!canCommand}
                        title={running ? "Send a direct message" : "Server is stopped"}
                        aria-label={`Direct message ${player.name}`}
                        onClick={() => directMessage(player)}
                      >
                        DM
                      </button>
                      <button
                        className="pw-action"
                        type="button"
                        disabled={!canCommand}
                        title={running ? "Toggle operator role" : "Server is stopped"}
                        aria-label={`Toggle operator role for ${player.name}`}
                        onClick={() => void runAction(player.op ? "deop" : "op", player)}
                      >
                        {player.op ? "De-OP" : "OP"}
                      </button>
                      <button
                        className="pw-action"
                        type="button"
                        disabled={!canCommand}
                        title={running ? "Kick this player (asks to confirm)" : "Server is stopped"}
                        aria-label={`Kick ${player.name}`}
                        onClick={() => kick(player)}
                      >
                        Kick
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <footer className="pw-foot">
          <span className="pw-foot-count" role="status" aria-live="polite">
            {rows.length} of {players?.players.length ?? 0} players shown
          </span>
          <span className="spacer" />
        </footer>
      </section>

      <section className="card pw-panel" aria-labelledby="pw-whitelist-title">
        <header className="pw-head">
          <span className="codicon codicon-shield" aria-hidden="true" />
          <h2 id="pw-whitelist-title">Whitelist</h2>
          <span className="pw-chip">
            <b>{whitelistNames.length}</b> name(s)
          </span>
          <span
            className="pw-meta"
            title={whitelistEnabled === null ? "white-list key not present in server.properties" : undefined}
          >
            {whitelistEnabled === null
              ? "server.properties unavailable"
              : whitelistEnabled
                ? "enabled · only listed players may join"
                : "disabled · whitelist not enforced"}
          </span>
          <span className="spacer" />
          <label className="opt-toggle">
            <input
              type="checkbox"
              checked={whitelistEnabled === true}
              disabled={busy || running || whitelistEnabled === null}
              title={
                running
                  ? "Stop the server to change the whitelist property"
                  : "Toggle white-list in server.properties"
              }
              onChange={(event) => void toggleWhitelistEnabled(event.target.checked)}
            />
            Whitelist enabled
          </label>
        </header>

        <div className="pw-toolbar">
          <label className="pw-search">
            <span className="codicon codicon-add" aria-hidden="true" />
            <input
              type="text"
              value={whitelistName}
              onChange={(event) => setWhitelistName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addWhitelistName();
              }}
              placeholder="Player name (1-16 letters, digits, underscore)"
              aria-label="Player name to add to the whitelist"
              disabled={!canCommand}
              title={running ? "Adds via the game's `whitelist add` command" : "Server is stopped"}
            />
          </label>
          <button
            className="pw-action"
            type="button"
            disabled={!canCommand || !whitelistName.trim()}
            title={running ? "Send `whitelist add <name>`" : "Server is stopped"}
            onClick={addWhitelistName}
          >
            Add
          </button>
        </div>

        <div className="pw-tablewrap">
          <table className="pw-table">
            <caption className="pw-caption">Names in whitelist.json / allowlist.json</caption>
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col" className="pw-col-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {whitelistNames.length === 0 ? (
                <tr>
                  <td colSpan={2} className="pw-empty">
                    No names in the whitelist file. {running ? "Add a name above." : "Start the server to add names."}
                  </td>
                </tr>
              ) : (
                whitelistNames.map((name) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="pw-col-actions">
                      <button
                        className="pw-action"
                        type="button"
                        disabled={!canCommand}
                        title={running ? "Send `whitelist remove <name>` (asks to confirm)" : "Server is stopped"}
                        aria-label={`Remove ${name} from the whitelist`}
                        onClick={() => removeWhitelistName(name)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {!running ? (
          <p className="pw-provenance">
            Add/remove names need a running server (they are sent as console `whitelist` commands); enable/disable still
            edits server.properties while stopped.
          </p>
        ) : null}
      </section>
    </div>
  );
}
