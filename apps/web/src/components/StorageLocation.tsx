import { useEffect, useState } from "react";
import type { ServerRecord, StorageStatus } from "@mcm/contracts";
import { api, describeError } from "../api";
import { ErrorText } from "./Feedback";

/**
 * Storage location: read-only. Files now live only in the container-side WSL distro root
 * (`/server/<id>`), so there is no host folder to pin. This shows the canonical root and the
 * migration diagnostics reported by `GET /api/storage`.
 */
export function StorageLocation({ server }: { server: ServerRecord }) {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus(null);
    setError(null);
    api.storage().catch((err) => setError(describeError(err)));
  }, [server.id]);

  return (
    <div className="card">
      <h2>Storage</h2>
      <p className="muted">
        Files live only inside the container-side distro ({status?.mode === "wsl" ? "WSL" : "host"} mode),
        never on a host folder. Nothing is copied and no folder here is deleted.
      </p>
      <dl className="kv">
        <dt>Server root</dt>
        <dd>
          <code>{`/server/${server.id}`}</code>
        </dd>
        <dt>Storage root</dt>
        <dd>
          <code>{status?.root ?? "-"}</code>
        </dd>
        <dt>Migration</dt>
        <dd>
          {status
            ? status.needsMigration
              ? `pending (${status.pending} to move)`
              : "canonical"
            : "-"}
        </dd>
      </dl>
      <ErrorText message={error} />
    </div>
  );
}
