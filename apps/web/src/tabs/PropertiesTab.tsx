import { useCallback, useEffect, useState } from "react";
import { DIFFICULTIES, GAMEMODES } from "@mcm/contracts";
import type { Difficulty, GameMode, ServerPropertiesView } from "@mcm/contracts";
import { api, describeError } from "../api";
import { Banner, ErrorText } from "../components/Feedback";

/**
 * Properties tab: the twelve allow-listed server.properties fields from the contract.
 * GET works always (a missing file yields Minecraft defaults); PATCH is refused by
 * the backend while the server runs, so inputs are disabled and explained up front.
 * Fields are ordered to match the panel spec: slots, gamemode, difficulty, then the
 * whitelist/cracked/flight/force-gamemode toggles, spawn protection, resource pack.
 */

interface PropertiesForm {
  maxPlayers: string;
  gamemode: GameMode;
  difficulty: Difficulty;
  whitelistEnabled: boolean;
  onlineMode: boolean;
  allowFlight: boolean;
  forceGamemode: boolean;
  pvp: boolean;
  spawnProtection: string;
  resourcePackRequired: boolean;
  resourcePack: string;
  resourcePackPrompt: string;
}

function toForm(view: ServerPropertiesView): PropertiesForm {
  return {
    maxPlayers: String(view.maxPlayers),
    gamemode: view.gamemode,
    difficulty: view.difficulty,
    whitelistEnabled: view.whitelistEnabled,
    onlineMode: view.onlineMode,
    allowFlight: view.allowFlight,
    forceGamemode: view.forceGamemode,
    pvp: view.pvp,
    spawnProtection: String(view.spawnProtection),
    resourcePackRequired: view.resourcePackRequired,
    resourcePack: view.resourcePack,
    resourcePackPrompt: view.resourcePackPrompt,
  };
}

export function PropertiesTab({ serverId, running }: { serverId: string; running: boolean }) {
  const [view, setView] = useState<ServerPropertiesView | null>(null);
  const [form, setForm] = useState<PropertiesForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.properties(serverId);
      setView(data);
      setForm(toForm(data));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof PropertiesForm>(key: K, value: PropertiesForm[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save() {
    if (!form) return;
    const maxPlayers = Number(form.maxPlayers);
    const spawnProtection = Number(form.spawnProtection);
    if (!Number.isFinite(maxPlayers) || !Number.isInteger(maxPlayers) || maxPlayers < 1) {
      setError("max players must be a whole number of at least 1");
      return;
    }
    if (!Number.isFinite(spawnProtection) || !Number.isInteger(spawnProtection) || spawnProtection < 0) {
      setError("spawn protection must be a whole number of 0 or more");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateProperties(serverId, {
        maxPlayers,
        gamemode: form.gamemode,
        difficulty: form.difficulty,
        whitelistEnabled: form.whitelistEnabled,
        onlineMode: form.onlineMode,
        allowFlight: form.allowFlight,
        forceGamemode: form.forceGamemode,
        pvp: form.pvp,
        spawnProtection,
        resourcePackRequired: form.resourcePackRequired,
        resourcePack: form.resourcePack,
        resourcePackPrompt: form.resourcePackPrompt,
      });
      setView(res.properties);
      setForm(toForm(res.properties));
      setNotice(res.changed.length ? `saved: ${res.changed.join(", ")}` : "no changes on disk");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const disabled = running || busy || loading || form === null;

  return (
    <section className="card pw-panel" aria-labelledby="props-title">
      <header className="pw-head">
        <span className="codicon codicon-settings-gear" aria-hidden="true" />
        <h2 id="props-title">server.properties</h2>
        {(() => {
          const metaText = view
            ? view.source === "file"
              ? `read from file${view.reason ? ` · ${view.reason}` : ""}`
              : `file absent — Minecraft defaults shown${view.reason ? ` · ${view.reason}` : ""}`
            : "loading";
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
          title="Reload server.properties from disk"
          aria-label="Reload server properties"
          onClick={() => void load()}
        >
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
      </header>

      {running && (
        <Banner>
          Server is running — stop it to save. The live JVM rewrites server.properties on stop, so PATCH is only
          allowed while the server is stopped.
        </Banner>
      )}
      <ErrorText message={error} />
      {notice ? <p className="pw-notice">{notice}</p> : null}

      {form === null ? (
        <p className="muted">{loading ? "Loading properties..." : "Properties unavailable."}</p>
      ) : (
        <>
          <div className="form-grid">
            <label className="field">
              Slots (max players)
              <input
                type="number"
                min={1}
                step={1}
                value={form.maxPlayers}
                disabled={disabled}
                onChange={(e) => set("maxPlayers", e.target.value)}
              />
            </label>
            <label className="field">
              Gamemode
              <select
                value={form.gamemode}
                disabled={disabled}
                onChange={(e) => set("gamemode", e.target.value as GameMode)}
              >
                {GAMEMODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Difficulty
              <select
                value={form.difficulty}
                disabled={disabled}
                onChange={(e) => set("difficulty", e.target.value as Difficulty)}
              >
                {DIFFICULTIES.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="props-toggles">
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={form.whitelistEnabled}
                disabled={disabled}
                onChange={(e) => set("whitelistEnabled", e.target.checked)}
              />
              Whitelist
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={!form.onlineMode}
                disabled={disabled}
                onChange={(e) => set("onlineMode", !e.target.checked)}
              />
              Cracked
              <span
                className="opt-toggle-info codicon codicon-info"
                title="Cracked = online-mode=false (no Mojang authentication); unchecked keeps online-mode=true"
              />
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={form.allowFlight}
                disabled={disabled}
                onChange={(e) => set("allowFlight", e.target.checked)}
              />
              Fly
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={form.pvp}
                disabled={disabled}
                onChange={(e) => set("pvp", e.target.checked)}
              />
              PvP
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={form.forceGamemode}
                disabled={disabled}
                onChange={(e) => set("forceGamemode", e.target.checked)}
              />
              Force Gamemode
            </label>
            <label className="field">
              Spawn Protection (blocks)
              <input
                type="number"
                min={0}
                step={1}
                value={form.spawnProtection}
                disabled={disabled}
                onChange={(e) => set("spawnProtection", e.target.value)}
              />
            </label>
            <label className="opt-toggle">
              <input
                type="checkbox"
                checked={form.resourcePackRequired}
                disabled={disabled}
                onChange={(e) => set("resourcePackRequired", e.target.checked)}
              />
              Resource pack required
            </label>
          </div>
          <div className="form-grid-wide">
            <label className="field">
              Resource pack
              <input
                type="text"
                value={form.resourcePack}
                placeholder="none"
                disabled={disabled}
                onChange={(e) => set("resourcePack", e.target.value)}
              />
            </label>
            <label className="field">
              Resource pack prompt
              <input
                type="text"
                value={form.resourcePackPrompt}
                placeholder="none"
                disabled={disabled}
                onChange={(e) => set("resourcePackPrompt", e.target.value)}
              />
            </label>
          </div>
        </>
      )}

      <footer className="pw-foot">
        <span className="pw-foot-count" role="status" aria-live="polite">
          {view ? `${view.knownKeys.length} recognised key(s) present` : ""}
        </span>
        <span className="spacer" />
        <button type="button" disabled={disabled} onClick={() => void save()}>
          {running ? "Stop server to save" : "Save changes"}
        </button>
      </footer>
    </section>
  );
}
