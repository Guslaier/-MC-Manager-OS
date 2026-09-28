import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Pure helpers for Player & World management. Nothing here touches Express or the
 * process tree: the module only validates operator input into a fixed console
 * command line, parses the game's own `list` output, and reads the server's
 * canonical data files. Keeping the command builders here (and unit-testable)
 * means no route ever concatenates arbitrary operator text into a shell/console
 * line without passing through a strict allow-list first.
 */

/** Java-edition player names: 1-16 ASCII letters, digits or underscore. */
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

/** World/dimension folder names this service will ever read: a safe basename only. */
const FOLDER_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Upper bound on a `say`/DM body, so a message can never become a console flood. */
export const MAX_MESSAGE_LEN = 256;

/** Soft cap on a per-dimension directory walk, so a pathological world cannot hang the route. */
const MAX_WORLD_FILES = 200_000;

/** Canonical Java whitelist file beside server.properties (Bedrock writes allowlist.json). */
export const WHITELIST_FILE = "whitelist.json";

/** True when `name` is a syntactically valid Minecraft player name. */
export function isPlayerName(name: unknown): name is string {
  return typeof name === "string" && PLAYER_NAME_RE.test(name);
}

/** True when `name` is a safe single path segment (no separators, no traversal). */
export function isSafeFolderName(name: unknown): name is string {
  return typeof name === "string" && FOLDER_NAME_RE.test(name) && name !== "." && name !== "..";
}

/**
 * True when a `say` body is safe to send as one console line: non-empty, length
 * bounded, and free of newlines/control characters. Rejecting those bytes is what
 * stops a message from smuggling a second command line into the server stdin.
 */
export function isSafeMessage(message: unknown): message is string {
  if (typeof message !== "string") return false;
  if (message.length === 0 || message.length > MAX_MESSAGE_LEN) return false;
  return !/[\r\n\u0000-\u001f\u007f]/.test(message);
}

/** Operator input accepted by {@link planPlayerAction}. */
export interface PlayerActionInput {
  action?: unknown;
  player?: unknown;
  message?: unknown;
  confirm?: unknown;
}

/**
 * Maps a validated operator request to exactly one console command line, or a
 * reason string when the request is rejected. The only variable text that ever
 * reaches a command is a name matching {@link PLAYER_NAME_RE} or a `say` body
 * matching {@link isSafeMessage}; everything else is a fixed literal.
 */
export function planPlayerAction(input: PlayerActionInput): { command: string } | { error: string } {
  const action = typeof input.action === "string" ? input.action : "";
  const invalidName = "player must be a valid Minecraft name (1-16 letters, digits or underscore)";
  switch (action) {
    case "kick": {
      if (!isPlayerName(input.player)) return { error: invalidName };
      // Kick disconnects a live player, so it demands an explicit echo of the name.
      if (String(input.confirm ?? "") !== input.player) {
        return { error: `kick is destructive: resend with confirm:"${input.player}"` };
      }
      return { command: `kick ${input.player}` };
    }
    case "op":
      if (!isPlayerName(input.player)) return { error: invalidName };
      return { command: `op ${input.player}` };
    case "deop":
      if (!isPlayerName(input.player)) return { error: invalidName };
      return { command: `deop ${input.player}` };
    case "whitelist-add":
      if (!isPlayerName(input.player)) return { error: invalidName };
      return { command: `whitelist add ${input.player}` };
    case "whitelist-remove":
      if (!isPlayerName(input.player)) return { error: invalidName };
      // Removing a name revokes join access, so it demands an explicit echo like kick.
      if (String(input.confirm ?? "") !== input.player) {
        return { error: `whitelist-remove is destructive: resend with confirm:"${input.player}"` };
      }
      return { command: `whitelist remove ${input.player}` };
    case "say": {
      if (!isSafeMessage(input.message)) {
        return { error: `message must be 1-${MAX_MESSAGE_LEN} characters without control characters` };
      }
      // A named target turns the broadcast into a directed `say <Name> <text>`.
      if (input.player !== undefined && input.player !== "") {
        if (!isPlayerName(input.player)) return { error: invalidName };
        return { command: `say ${input.player} ${input.message}` };
      }
      return { command: `say ${input.message}` };
    }
    default:
      return { error: `unknown action: ${action || "(none)"}` };
  }
}

export interface ParsedList {
  onlineCount: number;
  maxPlayers: number;
  names: string[];
}

/**
 * Parses a vanilla/Paper `list` output line, e.g.
 * `There are 2 of a max of 20 players online: Steve, Alex`. Returns null when the
 * line is not a player-list report, so callers can keep scanning the console.
 */
export function parseListLine(line: string): ParsedList | null {
  if (!line || !line.includes("players online")) return null;
  const match = line.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/i);
  if (!match) return null;
  const onlineCount = Number(match[1]);
  const maxPlayers = Number(match[2]);
  if (!Number.isFinite(onlineCount) || !Number.isFinite(maxPlayers)) return null;
  const rest = match[3].trim();
  const names = rest
    ? rest
        .split(",")
        .map((name) => name.trim())
        .filter((name) => PLAYER_NAME_RE.test(name))
    : [];
  return { onlineCount, maxPlayers, names };
}

/** Reads a `key=value` properties file into a plain map; missing/corrupt yields {}. */
export function readProperties(absPath: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Raw text of a `key=value` properties file; a missing/unreadable file yields "". */
export function readPropertiesText(absPath: string): string {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

/** Property key mapped to each editable core field (contract camelCase -> server.properties). */
export const SERVER_PROPERTY_KEYS = {
  maxPlayers: "max-players",
  gamemode: "gamemode",
  difficulty: "difficulty",
  whitelistEnabled: "white-list",
  onlineMode: "online-mode",
  allowFlight: "allow-flight",
  forceGamemode: "force-gamemode",
  pvp: "pvp",
  spawnProtection: "spawn-protection",
  resourcePackRequired: "resource-pack-required",
  resourcePack: "resource-pack",
  resourcePackPrompt: "resource-pack-prompt",
} as const;

export type ServerPropertyField = keyof typeof SERVER_PROPERTY_KEYS;

/** Enum + numeric bounds shared with the contract layer (kept as plain constants here). */
export const GAMEMODE_VALUES = ["survival", "creative", "adventure", "spectator"] as const;
export const DIFFICULTY_VALUES = ["peaceful", "easy", "normal", "hard"] as const;
export const MAX_MAX_PLAYERS = 1000;
export const MAX_SPAWN_PROTECTION = 1000;
export const MAX_RESOURCE_PACK_LEN = 2048;
export const MAX_RESOURCE_PACK_PROMPT_LEN = 256;

/** Typed core values, after defaults are applied for absent/unparseable keys. */
export interface ServerPropertyValues {
  maxPlayers: number;
  gamemode: string;
  difficulty: string;
  whitelistEnabled: boolean;
  onlineMode: boolean;
  allowFlight: boolean;
  forceGamemode: boolean;
  pvp: boolean;
  spawnProtection: number;
  resourcePackRequired: boolean;
  resourcePack: string;
  resourcePackPrompt: string;
}

/** Minecraft's own defaults for the editable core, used when a key is absent. */
export const SERVER_PROPERTY_DEFAULTS: ServerPropertyValues = {
  maxPlayers: 20,
  gamemode: "survival",
  difficulty: "easy",
  whitelistEnabled: false,
  onlineMode: true,
  allowFlight: false,
  forceGamemode: false,
  pvp: true,
  spawnProtection: 16,
  resourcePackRequired: false,
  resourcePack: "",
  resourcePackPrompt: "",
};

/** True when text can be written as one property value: bounded, no CR/LF/control bytes. */
export function isSafePropertyText(value: string, maxLen: number): boolean {
  if (value.length > maxLen) return false;
  return !/[\r\n\u0000-\u001f\u007f]/.test(value);
}

function sanitizePropertyText(value: string | undefined, maxLen: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return isSafePropertyText(trimmed, maxLen) ? trimmed : undefined;
}

function parseBoolProp(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseBoundedInt(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Applies Minecraft's defaults to a raw properties map. `white-list` accepts the
 * legacy `whitelist` alias (older builds wrote it without the dash); an absent or
 * unparseable value falls back to the default instead of guessing a wrong one.
 */
export function resolveServerProperties(props: Record<string, string>): {
  values: ServerPropertyValues;
  present: boolean;
} {
  const d = SERVER_PROPERTY_DEFAULTS;
  const whitelistRaw = props["white-list"] ?? props["whitelist"];
  const gamemode = props["gamemode"];
  const difficulty = props["difficulty"];
  return {
    present: Object.keys(props).length > 0,
    values: {
      maxPlayers: parseBoundedInt(props["max-players"], 1, MAX_MAX_PLAYERS) ?? d.maxPlayers,
      gamemode: gamemode !== undefined && (GAMEMODE_VALUES as readonly string[]).includes(gamemode) ? gamemode : d.gamemode,
      difficulty:
        difficulty !== undefined && (DIFFICULTY_VALUES as readonly string[]).includes(difficulty) ? difficulty : d.difficulty,
      whitelistEnabled: parseBoolProp(whitelistRaw) ?? d.whitelistEnabled,
      onlineMode: parseBoolProp(props["online-mode"]) ?? d.onlineMode,
      allowFlight: parseBoolProp(props["allow-flight"]) ?? d.allowFlight,
      forceGamemode: parseBoolProp(props["force-gamemode"]) ?? d.forceGamemode,
      pvp: parseBoolProp(props["pvp"]) ?? d.pvp,
      spawnProtection: parseBoundedInt(props["spawn-protection"], 0, MAX_SPAWN_PROTECTION) ?? d.spawnProtection,
      resourcePackRequired: parseBoolProp(props["resource-pack-required"]) ?? d.resourcePackRequired,
      resourcePack: sanitizePropertyText(props["resource-pack"], MAX_RESOURCE_PACK_LEN) ?? d.resourcePack,
      resourcePackPrompt: sanitizePropertyText(props["resource-pack-prompt"], MAX_RESOURCE_PACK_PROMPT_LEN) ?? d.resourcePackPrompt,
    },
  };
}

/** One `key=value` line to write into server.properties. */
export interface PropertyWrite {
  key: string;
  value: string;
}

/**
 * Validates an operator patch against the editable core and converts it to
 * `key=value` writes. Unknown keys, wrong types, out-of-range numbers and invalid
 * enums are rejected with a reason. `onlineMode`/`cracked` are mutually exclusive
 * inverses, so a self-contradicting pair can never half-apply.
 */
export function planPropertiesPatch(input: Record<string, unknown>): { writes: PropertyWrite[] } | { error: string } {
  const allowed = [...Object.keys(SERVER_PROPERTY_KEYS), "cracked"];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      return { error: `unknown field: ${key} (editable: ${allowed.join(", ")})` };
    }
  }
  const writes: PropertyWrite[] = [];
  const K = SERVER_PROPERTY_KEYS;
  const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

  if (input.maxPlayers !== undefined) {
    const v = input.maxPlayers;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_MAX_PLAYERS) {
      return { error: `maxPlayers must be an integer 1-${MAX_MAX_PLAYERS}` };
    }
    writes.push({ key: K.maxPlayers, value: String(v) });
  }
  if (input.gamemode !== undefined) {
    if (typeof input.gamemode !== "string" || !(GAMEMODE_VALUES as readonly string[]).includes(input.gamemode)) {
      return { error: `gamemode must be one of: ${GAMEMODE_VALUES.join(", ")}` };
    }
    writes.push({ key: K.gamemode, value: input.gamemode });
  }
  if (input.difficulty !== undefined) {
    if (typeof input.difficulty !== "string" || !(DIFFICULTY_VALUES as readonly string[]).includes(input.difficulty)) {
      return { error: `difficulty must be one of: ${DIFFICULTY_VALUES.join(", ")}` };
    }
    writes.push({ key: K.difficulty, value: input.difficulty });
  }
  if (input.whitelistEnabled !== undefined) {
    const v = bool(input.whitelistEnabled);
    if (v === null) return { error: "whitelistEnabled must be a boolean" };
    writes.push({ key: K.whitelistEnabled, value: v ? "true" : "false" });
  }
  if (input.onlineMode !== undefined && input.cracked !== undefined) {
    const om = bool(input.onlineMode);
    if (om === null) return { error: "onlineMode must be a boolean" };
    const cr = bool(input.cracked);
    if (cr === null) return { error: "cracked must be a boolean" };
    if (om === cr) return { error: "onlineMode and cracked are inverses; supply only one" };
    writes.push({ key: K.onlineMode, value: om ? "true" : "false" });
  } else if (input.onlineMode !== undefined) {
    const v = bool(input.onlineMode);
    if (v === null) return { error: "onlineMode must be a boolean" };
    writes.push({ key: K.onlineMode, value: v ? "true" : "false" });
  } else if (input.cracked !== undefined) {
    const v = bool(input.cracked);
    if (v === null) return { error: "cracked must be a boolean" };
    // cracked is the inverse of online-mode: cracked=true -> online-mode=false.
    writes.push({ key: K.onlineMode, value: v ? "false" : "true" });
  }
  if (input.allowFlight !== undefined) {
    const v = bool(input.allowFlight);
    if (v === null) return { error: "allowFlight must be a boolean" };
    writes.push({ key: K.allowFlight, value: v ? "true" : "false" });
  }
  if (input.forceGamemode !== undefined) {
    const v = bool(input.forceGamemode);
    if (v === null) return { error: "forceGamemode must be a boolean" };
    writes.push({ key: K.forceGamemode, value: v ? "true" : "false" });
  }
  if (input.pvp !== undefined) {
    const v = bool(input.pvp);
    if (v === null) return { error: "pvp must be a boolean" };
    writes.push({ key: K.pvp, value: v ? "true" : "false" });
  }
  if (input.resourcePackRequired !== undefined) {
    const v = bool(input.resourcePackRequired);
    if (v === null) return { error: "resourcePackRequired must be a boolean" };
    writes.push({ key: K.resourcePackRequired, value: v ? "true" : "false" });
  }
  if (input.spawnProtection !== undefined) {
    const v = input.spawnProtection;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_SPAWN_PROTECTION) {
      return { error: `spawnProtection must be an integer 0-${MAX_SPAWN_PROTECTION}` };
    }
    writes.push({ key: K.spawnProtection, value: String(v) });
  }
  if (input.resourcePack !== undefined) {
    if (typeof input.resourcePack !== "string" || !isSafePropertyText(input.resourcePack.trim(), MAX_RESOURCE_PACK_LEN)) {
      return { error: `resourcePack must be a URL up to ${MAX_RESOURCE_PACK_LEN} characters without control characters` };
    }
    writes.push({ key: K.resourcePack, value: input.resourcePack.trim() });
  }
  if (input.resourcePackPrompt !== undefined) {
    if (
      typeof input.resourcePackPrompt !== "string" ||
      !isSafePropertyText(input.resourcePackPrompt.trim(), MAX_RESOURCE_PACK_PROMPT_LEN)
    ) {
      return { error: `resourcePackPrompt must be up to ${MAX_RESOURCE_PACK_PROMPT_LEN} characters without control characters` };
    }
    writes.push({ key: K.resourcePackPrompt, value: input.resourcePackPrompt.trim() });
  }
  if (!writes.length) return { error: "no editable fields supplied" };
  return { writes };
}

/**
 * Applies `writes` to a server.properties body line by line: comment (`#`/`!`),
 * blank and unrecognised lines are preserved verbatim, an existing key keeps its
 * position and the exact text left of `=`, and any key not already present is
 * appended. The original newline style and a single trailing newline are kept.
 */
export function mergeProperties(text: string, writes: ReadonlyArray<PropertyWrite>): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Map(writes.map((w) => [w.key, w.value]));
  const lines = text.length ? text.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) {
      out.push(line);
      continue;
    }
    out.push(`${key}=${pending.get(key) as string}`);
    pending.delete(key);
  }
  for (const w of writes) {
    if (pending.has(w.key)) {
      out.push(`${w.key}=${w.value}`);
      pending.delete(w.key);
    }
  }
  if (out.length && out[out.length - 1] === "") out.pop();
  return out.join(eol) + eol;
}

/**
 * Persists a properties body atomically: write a sibling temp file, then rename it
 * over the target, so a crash mid-write cannot truncate server.properties.
 */
export function writePropertiesAtomic(absPath: string, content: string): void {
  const tmp = `${absPath}.tmp-${process.pid.toString(36)}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, absPath);
}

/**
 * Reads a Minecraft player list JSON (`ops.json`, `whitelist.json`) and returns
 * the `name` fields. Tolerates a missing or malformed file by returning [].
 */
export function readJsonNameList(absPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    const names: string[] = [];
    for (const entry of parsed) {
      const name = (entry as { name?: unknown } | null)?.name;
      if (isPlayerName(name)) names.push(name);
    }
    return names;
  } catch {
    return [];
  }
}

export interface DirSummary {
  sizeBytes: number;
  files: number;
  modifiedAt: string | null;
}

/**
 * Walks a world directory and sums real file sizes plus the newest mtime. The walk
 * is depth-first with a hard file cap; any unreadable entry is skipped rather than
 * failing the whole read.
 */
export function summarizeDir(absDir: string): DirSummary {
  let sizeBytes = 0;
  let files = 0;
  let newestMs = 0;
  const stack: string[] = [absDir];
  while (stack.length && files < MAX_WORLD_FILES) {
    const dir = stack.pop() as string;
    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory) {
        stack.push(child);
        continue;
      }
      try {
        const stat = statSync(child);
        sizeBytes += stat.size;
        files += 1;
        if (stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
      } catch {
        // Unreadable file (locked, permission) - skip it, keep the rest honest.
      }
    }
  }
  return { sizeBytes, files, modifiedAt: newestMs ? new Date(newestMs).toISOString() : null };
}
