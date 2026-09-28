import { TAG, compoundChild, readLevelDat, stringChild, writeLevelDatAtomic, type NbtTag, type NbtValue } from "./nbt.js";

/**
 * Vanilla Java Edition gamerule support. Gamerules live inside `level.dat` as
 * string tags under `Data.GameRules` (e.g. `doDaylightCycle` -> `"true"`), NOT in a
 * separate `game_rules.dat`. This module reads that nested compound, validates an
 * operator patch against a fixed catalog of real vanilla rules, and writes the
 * change back through the lossless NBT layer so every unrelated tag is preserved.
 */

/** A gamerule's value type as the game stores it. */
export type GameruleType = "boolean" | "integer";

export interface GameruleDef {
  /** Canonical camelCase name as written in `level.dat`. */
  name: string;
  type: GameruleType;
  /** Vanilla default, used when the rule is absent from the file. */
  default: boolean | number;
  /** Inclusive bounds for integer rules. */
  min?: number;
  max?: number;
  /** Human-readable description for the panel. */
  description: string;
}

/**
 * Catalog of common vanilla gamerules. Names are the exact `level.dat` keys; the
 * list is intentionally a fixed allow-list so an unknown/typo'd rule is rejected
 * rather than silently written as a tag the game would ignore.
 */
export const GAMERULE_DEFS: readonly GameruleDef[] = [
  { name: "doDaylightCycle", type: "boolean", default: true, description: "Advance the day/night cycle" },
  { name: "doWeatherCycle", type: "boolean", default: true, description: "Advance the weather cycle" },
  { name: "doMobSpawning", type: "boolean", default: true, description: "Allow mobs to spawn naturally" },
  { name: "doMobLoot", type: "boolean", default: true, description: "Mobs drop loot on death" },
  { name: "doTileDrops", type: "boolean", default: true, description: "Blocks drop items when broken" },
  { name: "doEntityDrops", type: "boolean", default: true, description: "Entities drop items on death" },
  { name: "keepInventory", type: "boolean", default: false, description: "Keep items on death" },
  { name: "mobGriefing", type: "boolean", default: true, description: "Mobs can change blocks" },
  { name: "naturalRegeneration", type: "boolean", default: true, description: "Players heal from food" },
  { name: "doFireTick", type: "boolean", default: true, description: "Fire spreads and burns out" },
  { name: "doImmediateRespawn", type: "boolean", default: false, description: "Respawn without the death screen" },
  { name: "fallDamage", type: "boolean", default: true, description: "Players take fall damage" },
  { name: "fireDamage", type: "boolean", default: true, description: "Players take fire damage" },
  { name: "drowningDamage", type: "boolean", default: true, description: "Players take drowning damage" },
  { name: "showDeathMessages", type: "boolean", default: true, description: "Broadcast death messages" },
  { name: "announceAdvancements", type: "boolean", default: true, description: "Broadcast advancement messages" },
  { name: "commandBlockOutput", type: "boolean", default: true, description: "Log command block output" },
  { name: "sendCommandFeedback", type: "boolean", default: true, description: "Show command feedback" },
  { name: "logAdminCommands", type: "boolean", default: true, description: "Log admin commands to the console" },
  { name: "reducedDebugInfo", type: "boolean", default: false, description: "Hide debug screen details" },
  { name: "spectatorsGenerateChunks", type: "boolean", default: true, description: "Spectators load chunks" },
  { name: "disableElytraMovementCheck", type: "boolean", default: false, description: "Disable elytra speed check" },
  { name: "doLimitedCrafting", type: "boolean", default: false, description: "Only allow unlocked recipes" },
  { name: "doInsomnia", type: "boolean", default: true, description: "Phantoms spawn from insomnia" },
  { name: "doPatrolSpawning", type: "boolean", default: true, description: "Pillager patrols spawn" },
  { name: "doTraderSpawning", type: "boolean", default: true, description: "Wandering traders spawn" },
  { name: "doWardenSpawning", type: "boolean", default: true, description: "Wardens spawn" },
  { name: "forgiveDeadPlayers", type: "boolean", default: true, description: "Angered mobs forgive dead players" },
  { name: "universalAnger", type: "boolean", default: false, description: "Angered mobs attack any player" },
  { name: "playersSleepingPercentage", type: "integer", default: 100, min: 0, max: 100, description: "Percent of players needed to skip night" },
  { name: "randomTickSpeed", type: "integer", default: 3, min: 0, max: 4096, description: "Random block ticks per chunk per tick" },
  { name: "spawnRadius", type: "integer", default: 10, min: 0, max: 100000, description: "Radius of the spawn protection area" },
  { name: "maxCommandChainLength", type: "integer", default: 65536, min: 0, max: 2147483647, description: "Max command chain length" },
  { name: "maxEntityCramming", type: "integer", default: 24, min: 0, max: 2147483647, description: "Entities before cramming damage" },
  { name: "commandModificationBlockLimit", type: "integer", default: 32768, min: 1, max: 2147483647, description: "Max blocks a command may modify" },
] as const;

const GAMERULE_BY_NAME = new Map(GAMERULE_DEFS.map((def) => [def.name, def]));

/** True when `name` is a known vanilla gamerule. */
export function isKnownGamerule(name: unknown): name is string {
  return typeof name === "string" && GAMERULE_BY_NAME.has(name);
}

/** One resolved gamerule value plus its provenance. */
export interface GameruleValue {
  name: string;
  type: GameruleType;
  value: boolean | number;
  /** `file` when present in level.dat; `default` when the rule was absent. */
  source: "file" | "default";
  description: string;
}

/** Parses a stored gamerule string into a typed value, or null when malformed. */
function parseStored(def: GameruleDef, raw: string): boolean | number | null {
  if (def.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }
  if (!/^-?\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (def.min !== undefined && n < def.min) return null;
  if (def.max !== undefined && n > def.max) return null;
  return n;
}

/** Serialises a typed gamerule value into the string the game stores. */
function serializeValue(def: GameruleDef, value: boolean | number): string {
  return def.type === "boolean" ? (value ? "true" : "false") : String(value);
}

/**
 * Locates the `Data.GameRules` compound inside a decoded `level.dat` root. Returns
 * null when the structure is absent (a world that has never been opened), so the
 * caller can report defaults instead of inventing a file.
 */
export function findGameRules(root: NbtTag): Map<string, NbtValue> | null {
  const data = compoundChild(root.value, "Data");
  if (!data) return null;
  const rules = data.get("GameRules");
  return rules && rules.type === TAG.Compound ? rules.value : null;
}

/**
 * Resolves the full catalog against the rules actually stored in `level.dat`.
 * A rule absent from the file is reported with its vanilla default and
 * `source:"default"`; a malformed stored value also falls back to the default.
 */
export function resolveGamerules(rules: Map<string, NbtValue> | null): GameruleValue[] {
  return GAMERULE_DEFS.map((def) => {
    const stored = rules?.get(def.name);
    if (stored && stored.type === TAG.String) {
      const parsed = parseStored(def, stored.value);
      if (parsed !== null) {
        return { name: def.name, type: def.type, value: parsed, source: "file", description: def.description };
      }
    }
    return { name: def.name, type: def.type, value: def.default, source: "default", description: def.description };
  });
}

/** A validated gamerule change to apply to `level.dat`. */
export interface GameruleWrite {
  name: string;
  value: boolean | number;
  /** The exact string to store in the NBT string tag. */
  stored: string;
}

/**
 * Validates an operator patch against the catalog. Unknown rule names, wrong value
 * types and out-of-range integers are rejected with a reason; a self-consistent
 * patch is converted to the string form the game stores.
 */
export function planGamerulesPatch(input: Record<string, unknown>): { writes: GameruleWrite[] } | { error: string } {
  const entries = Object.entries(input);
  if (!entries.length) return { error: "no gamerules supplied" };
  const writes: GameruleWrite[] = [];
  for (const [name, raw] of entries) {
    const def = GAMERULE_BY_NAME.get(name);
    if (!def) return { error: `unknown gamerule: ${name}` };
    if (def.type === "boolean") {
      if (typeof raw !== "boolean") return { error: `${name} must be a boolean` };
      writes.push({ name, value: raw, stored: serializeValue(def, raw) });
      continue;
    }
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
      return { error: `${name} must be an integer` };
    }
    if (def.min !== undefined && raw < def.min) return { error: `${name} must be >= ${def.min}` };
    if (def.max !== undefined && raw > def.max) return { error: `${name} must be <= ${def.max}` };
    writes.push({ name, value: raw, stored: serializeValue(def, raw) });
  }
  return { writes };
}

/**
 * Applies validated writes to the `Data.GameRules` compound in place, creating the
 * compound only when it is missing. Every other tag in the tree is left untouched,
 * so unrelated world data survives the edit.
 */
export function applyGamerules(root: NbtTag, writes: ReadonlyArray<GameruleWrite>): void {
  if (root.value.type !== TAG.Compound) throw new Error("level.dat root is not a compound");
  let data = root.value.value.get("Data");
  if (!data || data.type !== TAG.Compound) {
    data = { type: TAG.Compound, value: new Map<string, NbtValue>() };
    root.value.value.set("Data", data);
  }
  const dataMap = data.value as Map<string, NbtValue>;
  let rules = dataMap.get("GameRules");
  if (!rules || rules.type !== TAG.Compound) {
    rules = { type: TAG.Compound, value: new Map<string, NbtValue>() };
    dataMap.set("GameRules", rules);
  }
  const rulesMap = rules.value as Map<string, NbtValue>;
  for (const write of writes) {
    rulesMap.set(write.name, { type: TAG.String, value: write.stored });
  }
}

/** The full catalog with vanilla defaults, used when `level.dat` is absent. */
export function readGamerulesDefaults(): GameruleValue[] {
  return resolveGamerules(null);
}

/** Reads `level.dat` and returns the resolved gamerule catalog. */
export function readGamerules(absPath: string): { rules: GameruleValue[]; hasFile: boolean } {
  const root = readLevelDat(absPath);
  return { rules: resolveGamerules(findGameRules(root)), hasFile: true };
}

/**
 * Reads `level.dat`, applies the validated writes, and writes it back atomically.
 * Returns the names whose stored value actually changed.
 */
export function patchGamerules(absPath: string, writes: ReadonlyArray<GameruleWrite>): string[] {
  const root = readLevelDat(absPath);
  const before = findGameRules(root);
  const changed = writes
    .filter((write) => {
      const stored = before?.get(write.name);
      return !(stored && stored.type === TAG.String && stored.value === write.stored);
    })
    .map((write) => write.name);
  applyGamerules(root, writes);
  writeLevelDatAtomic(absPath, root);
  return changed;
}

// Self-check: run with MCM_GAMERULES_SELFCHECK=1 npx tsx apps/server/gamerules.ts
if (process.env.MCM_GAMERULES_SELFCHECK === "1") {
  const assert = (condition: boolean, message: string): void => {
    console.log(`${condition ? "ok" : "FAIL"}: ${message}`);
    if (!condition) process.exitCode = 1;
  };
  const { encodeNbt, parseNbt } = await import("./nbt.js");
  const { gunzipSync, gzipSync } = await import("node:zlib");

  // Build a synthetic level.dat with unrelated tags that must survive a patch.
  const rules = new Map<string, NbtValue>([
    ["doDaylightCycle", { type: TAG.String, value: "true" }],
    ["randomTickSpeed", { type: TAG.String, value: "3" }],
  ]);
  const data = new Map<string, NbtValue>([
    ["LevelName", { type: TAG.String, value: "world" }],
    ["GameRules", { type: TAG.Compound, value: rules }],
    ["SpawnX", { type: TAG.Int, value: 42 }],
    ["hardcore", { type: TAG.Byte, value: 0 }],
    ["seed", { type: TAG.Long, value: 1234567890123n }],
  ]);
  const root: NbtTag = { name: "", value: { type: TAG.Compound, value: new Map([["Data", { type: TAG.Compound, value: data }]]) } };

  // Round-trip through gzip + parse must be structurally identical.
  const roundTripped = parseNbt(gunzipSync(gzipSync(encodeNbt(root))));
  assert(roundTripped.value.type === TAG.Compound, "root round-trips as compound");
  assert(stringChild(roundTripped.value, "Data") === null, "Data is a compound, not a string");
  const rtData = compoundChild(roundTripped.value, "Data");
  assert(rtData?.get("LevelName")?.type === TAG.String, "LevelName string preserved");
  assert((rtData?.get("SpawnX") as { value: number } | undefined)?.value === 42, "SpawnX int preserved");
  assert((rtData?.get("seed") as { value: bigint } | undefined)?.value === 1234567890123n, "seed long preserved");

  // Resolve: file values win, absent rules fall back to defaults.
  const resolved = resolveGamerules(findGameRules(roundTripped));
  const byName = new Map(resolved.map((r) => [r.name, r]));
  assert(byName.get("doDaylightCycle")?.value === true && byName.get("doDaylightCycle")?.source === "file", "stored boolean read from file");
  assert(byName.get("randomTickSpeed")?.value === 3 && byName.get("randomTickSpeed")?.source === "file", "stored integer read from file");
  assert(byName.get("keepInventory")?.source === "default", "absent rule falls back to default");

  // Validation: unknown name, wrong type, out-of-range all rejected.
  assert("error" in planGamerulesPatch({ notARule: true }), "unknown gamerule rejected");
  assert("error" in planGamerulesPatch({ doDaylightCycle: 1 }), "non-boolean rejected for boolean rule");
  assert("error" in planGamerulesPatch({ randomTickSpeed: 99999 }), "out-of-range integer rejected");
  assert("error" in planGamerulesPatch({}), "empty patch rejected");

  // Apply: only the targeted rule changes; unrelated tags stay byte-identical.
  const plan = planGamerulesPatch({ doDaylightCycle: false, randomTickSpeed: 5 });
  assert(!("error" in plan), "valid patch accepted");
  if (!("error" in plan)) {
    applyGamerules(roundTripped, plan.writes);
    const after = findGameRules(roundTripped);
    assert(after?.get("doDaylightCycle")?.type === TAG.String && (after.get("doDaylightCycle") as { value: string }).value === "false", "boolean patched to false");
    assert((after?.get("randomTickSpeed") as { value: string } | undefined)?.value === "5", "integer patched to 5");
    const afterData = compoundChild(roundTripped.value, "Data");
    assert((afterData?.get("SpawnX") as { value: number } | undefined)?.value === 42, "unrelated SpawnX untouched");
    assert((afterData?.get("seed") as { value: bigint } | undefined)?.value === 1234567890123n, "unrelated seed untouched");
    assert(afterData?.get("hardcore")?.type === TAG.Byte, "unrelated hardcore byte untouched");
  }
}
