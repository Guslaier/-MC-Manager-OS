import { FileManager } from "../components/FileManager";

/** Files tab: the scoped file manager for one server. */
export function FilesTab({ serverId }: { serverId: string }) {
  return <FileManager scope={serverId} serverId={serverId} />;
}
