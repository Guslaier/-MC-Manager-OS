import "./load-env.js"; // must stay first: loads repo-root .env before any env reads
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ServerRecord, StorageStatus } from "@mcm/contracts";
import { dataRoot, storageMode } from "./files.js";

/** Registry file name, shared with the service (kept local to avoid a circular import). */
const STATE_FILE = "state.json";

/**
 * Pre-canonical PC root that still holds the live data until migration runs. Overridable so
 * the same script works on any checkout; defaults to the historical server cwd layout.
 */
const LEGACY_PC_ROOT = process.env.MCM_LEGACY_PC_ROOT ?? path.join(process.cwd(), "apps", "server", "data");

/** Only plain ids are ever joined into a path, so no record can escape either root. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Legacy per-server directory prefix (pre-canonical). */
const LEGACY_SCOPE_PREFIX = "servers";

function readRecords(statePath: string): ServerRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ServerRecord[]) : [];
  } catch {
    return [];
  }
}

/** Canonical state.json location (inside DATA_ROOT, i.e. the WSL-internal `/server`). */
function canonicalState(): string {
  return path.join(dataRoot(), STATE_FILE);
}

/** Legacy state.json location (PC-local, pre-canonical). */
function legacyState(): string {
  return path.join(LEGACY_PC_ROOT, STATE_FILE);
}

/**
 * Read-only migration diagnostics. Never writes, never deletes: it reports where the
 * canonical root is, whether it already holds a registry, and exactly which legacy
 * directories would be copied by `runMigration()`.
 */
export function migrationStatus(): StorageStatus {
  const root = dataRoot();
  const canonical = canonicalState();
  const legacy = legacyState();
  const hasCanonical = existsSync(canonical);
  const hasLegacy = existsSync(legacy);

  const records = readRecords(hasCanonical ? canonical : hasLegacy ? legacy : root);

  const dryRun: string[] = [];
  if (!hasCanonical && hasLegacy) dryRun.push(`copy ${STATE_FILE} -> ${canonical}`);

  let pending = 0;
  for (const record of records) {
    if (!SAFE_ID.test(record.id)) continue;
    const src = path.join(LEGACY_PC_ROOT, LEGACY_SCOPE_PREFIX, record.id);
    const dest = path.join(root, record.id);
    if (existsSync(src) && !existsSync(dest)) {
      pending += 1;
      dryRun.push(`copy ${LEGACY_SCOPE_PREFIX}/${record.id} -> ${record.id}`);
    }
  }

  return {
    root,
    mode: storageMode(),
    knownRecords: records.length,
    pending,
    needsMigration: (!hasCanonical && hasLegacy) || pending > 0,
    dryRun,
  };
}

/**
 * Non-destructive migration: copies the registry and each legacy server directory into the
 * canonical root, mapping `servers/<id>` to `server/<id>`. Sources are never modified or
 * deleted, an already-present destination is never overwritten, and it is idempotent
 * (a second run copies nothing). Deletion of the legacy tree is a separate, manual step.
 */
export function runMigration(): { root: string; mode: "wsl" | "host"; copied: string[]; skipped: string[] } {
  const root = dataRoot();
  const canonical = canonicalState();
  const legacy = legacyState();
  const copied: string[] = [];
  const skipped: string[] = [];

  mkdirSync(root, { recursive: true });

  // Registry: copied only when the canonical copy is missing (never overwritten).
  if (existsSync(canonical)) {
    skipped.push(`${STATE_FILE} already present`);
  } else if (existsSync(legacy)) {
    cpSync(legacy, canonical);
    copied.push(STATE_FILE);
  } else {
    skipped.push(`no legacy registry at ${legacy}`);
  }

  // Per-server dirs are independent of the registry copy: the loop always runs so a re-run
  // repairs the canonical `server/<id>` layout even when state.json already exists.
  const records = existsSync(canonical)
    ? readRecords(canonical)
    : existsSync(legacy)
      ? readRecords(legacy)
      : [];

  for (const record of records) {
    if (!SAFE_ID.test(record.id)) {
      skipped.push(`unsafe id: ${record.id}`);
      continue;
    }
    const src = path.join(LEGACY_PC_ROOT, LEGACY_SCOPE_PREFIX, record.id);
    const dest = path.join(root, record.id);
    if (!existsSync(src)) {
      skipped.push(`${LEGACY_SCOPE_PREFIX}/${record.id}: no legacy directory`);
      continue;
    }
    if (existsSync(dest)) {
      skipped.push(`${record.id}: destination exists`);
      continue;
    }
    cpSync(src, dest, { recursive: true });
    copied.push(record.id);
  }

  return { root, mode: storageMode(), copied, skipped };
}

/** CLI: `tsx apps/server/migration.ts` (status, default) or `... --apply` (non-destructive copy). */
if (process.argv[1] && /migration\.(ts|js)$/.test(process.argv[1])) {
  const result = process.argv.includes("--apply") ? runMigration() : migrationStatus();
  console.log(JSON.stringify(result, null, 2));
}
