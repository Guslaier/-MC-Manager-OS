import type { ProvisionReport, ServerRecord } from "@mcm/contracts";
import { ServerConfig } from "../components/ServerConfig";

/** Config tab: server settings plus runtime, storage, core files and Java cards. */
export function ConfigTab({
  server,
  provision,
  onChanged,
  onDelete,
}: {
  server: ServerRecord;
  provision: ProvisionReport | null;
  onChanged: () => void;
  onDelete: () => void;
}) {
  return <ServerConfig server={server} provision={provision} onChanged={onChanged} onDelete={onDelete} />;
}
