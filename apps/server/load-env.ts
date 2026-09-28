// Minimal dependency-free .env loader for the repo-root .env.
// Must be the FIRST import of the entrypoint so process.env is populated
// before any module reads it at top level (e.g. files.ts DATA_ROOT).
// Existing process.env values always win over .env entries.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * Platform-separated env loading so one clone can serve a Windows dev box and a
 * Linux host without leaking between them: the Windows file carries UNC
 * `MCM_DATA_DIR` and `MCM_RUNTIME_MODE=wsl`, which are both invalid on Linux.
 *
 * Resolution:
 *   - `MCM_ENV_FILE` (explicit override) is loaded ALONE and wins over everything.
 *   - otherwise `<repo>/.env.<platform>` (`.env.windows` | `.env.linux`) is loaded last,
 *     so it overrides same-named keys coming from the shared `<repo>/.env`.
 * Only keys this loader wrote can be overridden by a later file; genuine process
 * environment variables still win over every file.
 */
const platformFile = process.platform === "win32" ? ".env.windows" : ".env.linux";
const explicit = process.env.MCM_ENV_FILE;
const candidates = explicit
  ? [explicit]
  : [path.resolve(repoRoot, ".env"), path.resolve(repoRoot, platformFile)];
const loadedKeys = new Set<string>();

for (const envPath of candidates) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1];
    if (key in process.env && !loadedKeys.has(key)) continue; // real environment overrides file
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    loadedKeys.add(key);
  }
}
