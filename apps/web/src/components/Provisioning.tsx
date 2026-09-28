import { useCallback, useEffect, useState } from "react";
import type { ProvisionReport, ProvisionStep } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "./Feedback";

/**
 * REQ-1.1 host provisioning card. Shows the true host state and lets the operator
 * start one step at a time; every value comes from the backend report verbatim.
 */
export function Provisioning() {
  const [report, setReport] = useState<ProvisionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const refresh = useCallback(() => {
    api
      .provision()
      .then(setReport)
      .catch((err) => setError(describeError(err)));
  }, []);

  useEffect(() => {
    refresh();
    // Steps run detached on the server, so poll while one is in flight.
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (step: ProvisionStep) => {
      setPending(true);
      setError(null);
      try {
        setReport(await api.provisionStep(step));
      } catch (err) {
        setError(describeError(err));
      } finally {
        setPending(false);
        refresh();
      }
    },
    [refresh],
  );

  return (
    <div className="card">
      <h2>Provisioning</h2>
      <ErrorText message={error} />
      {report ? (
        <>
          <dl className="kv">
            <dt>State</dt>
            <dd>{report.state}</dd>
            <dt>Distro</dt>
            <dd>
              {report.distro} {report.distroPresent ? "(registered)" : "(absent)"}
            </dd>
            <dt>runc</dt>
            <dd>{report.runcVersion ?? "-"}</dd>
            <dt>cgroup v2</dt>
            <dd>{report.cgroup2 ? "yes" : "no"}</dd>
            <dt>Reason</dt>
            <dd>{report.reason}</dd>
          </dl>
          {report.restartRequired && (
            <p className="error">Windows restart required: restart the host, then retry this step.</p>
          )}
          {report.manualAction === "run_elevated_install" && (
            <p className="muted">
              The install step opens a UAC prompt on the host; a declined prompt is reported as a failure.
            </p>
          )}
          <div>
            <button className="ghost" disabled={pending || report.busy} onClick={() => run("install")}>
              Install WSL components
            </button>
            <button className="ghost" disabled={pending || report.busy} onClick={() => run("import")}>
              Import verified Alpine
            </button>
            <button className="ghost" disabled={pending || report.busy} onClick={() => run("runc")}>
              Install runc
            </button>
          </div>
        </>
      ) : (
        <p className="muted">Loading...</p>
      )}
    </div>
  );
}
