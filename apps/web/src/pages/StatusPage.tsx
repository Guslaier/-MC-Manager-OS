import { useEffect, useState } from "react";
import type { EngineProbe, ResourceStatus } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "../components/Feedback";
import { Provisioning } from "../components/Provisioning";
import { JavaProvisioning } from "../components/JavaProvisioning";

export function StatusPage({ engine }: { engine: EngineProbe | null }) {
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch((err) => setError(describeError(err)));
  }, []);

  return (
    <section className="cards">
      <div className="card">
        <h2>Host</h2>
        <ErrorText message={error} />
        {status ? (
          <dl className="kv">
            <dt>Hostname</dt>
            <dd>{status.hostname}</dd>
            <dt>Platform</dt>
            <dd>{status.platform}</dd>
            <dt>CPU cores</dt>
            <dd>{status.cpuCount}</dd>
            <dt>Load (1m)</dt>
            <dd>{status.loadAvg1m.toFixed(2)}</dd>
            <dt>Memory</dt>
            <dd>
              {status.freeMemoryMb} / {status.totalMemoryMb} MB free
            </dd>
            <dt>Uptime</dt>
            <dd>{Math.round(status.uptimeSeconds)} s</dd>
          </dl>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>

      <div className="card">
        <h2>Engine</h2>
        {engine ? (
          <dl className="kv">
            <dt>Available</dt>
            <dd>{engine.available ? "yes" : "no"}</dd>
            <dt>Mode</dt>
            <dd>{engine.mode ?? "-"}</dd>
            <dt>Reason</dt>
            <dd>{engine.reason}</dd>
            <dt>Runtime path</dt>
            <dd>{engine.runtimePath ?? "-"}</dd>
            <dt>Distro</dt>
            <dd>{engine.distro ?? "-"}</dd>
            <dt>runc</dt>
            <dd>{engine.runcVersion ?? "-"}</dd>
          </dl>
        ) : (
          <p className="muted">Loading...</p>
        )}
      </div>

      <Provisioning />
      <JavaProvisioning />
    </section>
  );
}
