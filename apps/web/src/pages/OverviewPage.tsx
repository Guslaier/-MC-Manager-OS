import { useState } from "react";
import type { EngineProbe, ServerRecord } from "@mcm/contracts";
import { ServerList } from "../components/ServerList";
import { CreateServerModal } from "../components/CreateServerModal";

/** Overview: the server table plus the page-owned create-server modal toggle. */
export function OverviewPage({
  servers,
  error,
  engine,
  onOpen,
  onChanged,
  onError,
}: {
  servers: ServerRecord[];
  error: string | null;
  engine: EngineProbe | null;
  onOpen: (id: string) => void;
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <>
      <ServerList
        servers={servers}
        error={error}
        engine={engine}
        onOpen={onOpen}
        onChanged={onChanged}
        onError={onError}
        onCreate={() => setCreating(true)}
      />
      {creating && (
        <CreateServerModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
