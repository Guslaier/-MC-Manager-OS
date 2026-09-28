import { useCallback, useEffect, useState } from "react";
import type { FileEntry } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText, Notice } from "./Feedback";

/**
 * Core + script management for one server, shown in its Configuration tab. Everything
 * comes from that server's own scoped dir: an existing .jar can be adopted as the launch
 * jar, a .jar can be uploaded as the canonical server.jar, and a .sh can be uploaded as a
 * script. rootfs is engine-owned and .bat cannot run in Linux, so neither is offered here;
 * the backend refuses both at the boundary too.
 */
export function ServerFiles({
  serverId,
  activeJar,
  running,
  onChanged,
}: {
  serverId: string;
  activeJar?: string | null;
  running: boolean;
  onChanged: () => void;
}) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listFiles(serverId, serverId)
      .then((listing) => setEntries(listing.entries))
      .catch((err) => setError(describeError(err)));
  }, [serverId]);

  useEffect(load, [load]);

  const files = entries.filter((e) => e.type === "file");
  const jarFiles = files.filter((e) => e.name.toLowerCase().endsWith(".jar"));
  const scriptFiles = files.filter((e) => e.name.toLowerCase().endsWith(".sh"));

  async function pickJar(name: string) {
    setError(null);
    setNotice(null);
    try {
      await api.selectServerJar(serverId, name);
      setNotice(`Adopted ${name} as the launch jar.`);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setNotice(null);
    const lower = file.name.toLowerCase();
    // Refused up front; the backend rejects .bat as unsupported_script_type as well.
    if (lower.endsWith(".bat")) {
      setError(".bat cannot execute in a Linux container; provide a .sh");
      return;
    }
    setBusy(true);
    try {
      if (lower.endsWith(".jar")) {
        const res = await api.uploadServerJar({ serverId, path: `${serverId}/server.jar` }, file);
        setNotice(`Uploaded ${file.name} (${res.totalBytes} bytes) as server.jar.`);
        onChanged();
      } else if (lower.endsWith(".sh")) {
        const res = await api.uploadChunk(`${serverId}/${file.name}`, file, 0, serverId);
        setNotice(`Uploaded ${file.name} (${res.totalBytes} bytes).`);
        load();
      } else {
        setError("Only .jar (core) or .sh (script) files are accepted.");
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Core & scripts</h2>
      <p className="muted">
        Only this server's own files are shown. A .jar can be adopted as the launch jar or uploaded as server.jar; a
        script must be .sh. rootfs is provisioned by the engine and is never editable here.
      </p>
      <ErrorText message={error} />
      <Notice message={notice} />
      <div className="row">
        <input
          type="file"
          accept=".jar,.sh"
          aria-label="upload core or script"
          disabled={running || busy}
          onChange={upload}
        />
        <span className="spacer" />
        {running && <span className="muted">Stop the server to change its files.</span>}
      </div>

      <h2>Core jars</h2>
      {!activeJar && !running && jarFiles.length > 0 && (
        <p className="muted">No launch jar active. Click &quot;Use as launch jar&quot; on one of the jars below.</p>
      )}
      {jarFiles.length === 0 ? (
        <p className="muted">No .jar in this server's directory. Upload a .jar above to use as the launch jar.</p>
      ) : (
        <ul className="listing">
          {jarFiles.map((f) => {
            const isActive = activeJar === f.name;
            return (
              <li key={f.name}>
                <code>{f.name}</code>
                <span className="muted">{f.sizeBytes} B</span>
                {isActive ? (
                  <span className="pw-badge" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>
                    active launch jar
                  </span>
                ) : (
                  <button className="ghost" disabled={running} onClick={() => pickJar(f.name)}>
                    Use as launch jar
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2>Scripts (.sh)</h2>
      {scriptFiles.length === 0 ? (
        <p className="muted">No .sh script in this server's directory.</p>
      ) : (
        <ul className="listing">
          {scriptFiles.map((f) => (
            <li key={f.name}>
              <code>{f.name}</code>
              <span className="muted">{f.sizeBytes} B</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
