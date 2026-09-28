// Launch command handling. A scriptRun is split into an argv array and validated
// before it is stored or handed to the runtime. The engine passes that array to
// runc as process.args - no shell is ever involved - so a metacharacter cannot be
// interpreted; the rejection below is defence in depth for any future join into a
// shell line and keeps the stored value unambiguous.
import type { ServerRecord } from "@mcm/contracts";
import { DEFAULT_BEDROCK_SCRIPT_RUN, DEFAULT_SCRIPT_RUN } from "@mcm/contracts";
import { JVM_DIR_PREFIX } from "./engine.js";

/** Ceilings on the stored command, so an oversized value can never be persisted. */
export const MAX_SCRIPT_RUN_LENGTH = 512;
export const MAX_SCRIPT_ARGS = 32;

/** Tokens that mean something to a POSIX shell; none are valid in an argv element. */
const SHELL_META_RE = /[;&|<>`$(){}[\]*?~!#\\'"]/;
/** NUL and every other control character, including newlines and tabs. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Executable token: a bare command or a path, never a traversal (checked first). */
const EXECUTABLE_RE = /^[A-Za-z0-9_.+/-]+$/;

/** Raised when a scriptRun is malformed; the message states the real problem. */
export class ScriptRunError extends Error {}

/**
 * Splits a scriptRun into argv and rejects anything that could be reinterpreted by
 * a shell or used to escape the server data dir. Throws ScriptRunError otherwise.
 */
export function parseScriptRun(scriptRun: unknown): string[] {
  if (typeof scriptRun !== "string") throw new ScriptRunError("scriptRun must be a string");
  const raw = scriptRun.trim();
  if (!raw) throw new ScriptRunError("scriptRun must not be empty");
  if (raw.length > MAX_SCRIPT_RUN_LENGTH) {
    throw new ScriptRunError(`scriptRun must be at most ${MAX_SCRIPT_RUN_LENGTH} characters`);
  }
  if (CONTROL_RE.test(raw)) {
    throw new ScriptRunError("scriptRun must not contain control or null characters");
  }
  const meta = SHELL_META_RE.exec(raw);
  if (meta) {
    throw new ScriptRunError(
      `scriptRun must not contain the shell metacharacter "${meta[0]}"; quoting, substitution, pipes and redirects are not supported`,
    );
  }
  const argv = raw.split(/\s+/);
  if (argv.length > MAX_SCRIPT_ARGS) {
    throw new ScriptRunError(`scriptRun must be at most ${MAX_SCRIPT_ARGS} tokens`);
  }
  for (const token of argv) {
    if (token.split("/").includes("..")) {
      throw new ScriptRunError(`scriptRun must not contain path traversal ("${token}")`);
    }
  }
  const exe = argv[0];
  if (exe.startsWith("-") || exe.endsWith("/") || !EXECUTABLE_RE.test(exe)) {
    throw new ScriptRunError(`scriptRun must start with an executable, not "${exe}"`);
  }
  return argv;
}

/** Non-throwing form for request validation: the problem, or null when valid. */
export function scriptRunProblem(scriptRun: unknown): string | null {
  try {
    parseScriptRun(scriptRun);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Builds the container argv for a server. The stored scriptRun is the source of
 * truth: a bare `java` first token is resolved to the provisioned JRE path, and the
 * record's memory ceiling is injected unless the script already sets -Xmx itself.
 */
export function buildContainerCommand(record: ServerRecord, javaReady: boolean): string[] {
  const isBedrock = record.serverType === "bedrock";
  const defaultRun = isBedrock ? DEFAULT_BEDROCK_SCRIPT_RUN : DEFAULT_SCRIPT_RUN;
  const argv = parseScriptRun(record.scriptRun ?? defaultRun);
  if (isBedrock) {
    // Bedrock binary runs directly as an ELF process, no JRE or JVM flags needed
    return argv;
  }
  const jreJava = `/usr/lib/jvm/${JVM_DIR_PREFIX[record.javaVersion]}/bin/java`;
  if (javaReady && argv[0] === "java") argv[0] = jreJava;
  if (argv[0] === jreJava || argv[0] === "java" || argv[0].endsWith("/java")) {
    if (!argv.some((token) => token.startsWith("-Xmx"))) {
      argv.splice(1, 0, `-Xmx${record.memoryMb}M`);
    }
    // Dual-stack networking: ensure Java binds and listens to both IPv4 and IPv6
    if (!argv.some((token) => token.toLowerCase().includes("preferipv4stack"))) {
      argv.splice(1, 0, "-Djava.net.preferIPv4Stack=false");
    }
    if (!argv.some((token) => token.toLowerCase().includes("preferipv6addresses"))) {
      argv.splice(1, 0, "-Djava.net.preferIPv6Addresses=true");
    }
  }
  return argv;
}
