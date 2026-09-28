import { useCallback, useEffect, useState } from "react";
import type { JavaInstallReport, JavaVersion } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "./Feedback";

/**
 * REQ-4.2 Java card: per-major-version status straight from the Alpine (musl) repos,
 * one install button each. Values are the backend report verbatim, so a failed
 * `apk add` shows the real reason instead of a fake "installed".
 */
export function JavaProvisioning() {
  const [reports, setReports] = useState<JavaInstallReport[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<JavaVersion | null>(null);

  const refresh = useCallback(() => {
    api
      .java()
      .then(setReports)
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(refresh, [refresh]);

  async function install(version: JavaVersion) {
    setPending(version);
    setError(null);
    try {
      const report = await api.javaInstall(version);
      setReports((prev) => prev.map((r) => (r.version === version ? report : r)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(null);
      refresh();
    }
  }

  return (
    <div className="card">
      <h2>Java (Alpine musl)</h2>
      <p className="muted">
        JREs come from the Alpine repos (openjdk8/17/21-jre) and are musl builds. Portable or glibc JDK URLs are
        refused by design - glibc binaries cannot run inside this Alpine rootfs.
      </p>
      <ErrorText message={error} />
      {reports.length === 0 ? (
        <p className="muted">Loading...</p>
      ) : (
        <ul className="listing">
          {reports.map((r) => (
            <li key={r.version}>
              <code>java {r.version}</code>
              <span className="state">{r.installed ? "installed" : "missing"}</span>
              <span className="muted">{r.versionOutput ?? r.reason}</span>
              <button className="ghost" disabled={pending !== null} onClick={() => install(r.version)}>
                {pending === r.version ? "Installing..." : "Install"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
