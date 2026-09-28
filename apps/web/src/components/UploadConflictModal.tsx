import type { UploadConflict, UploadConflictPolicy } from "@mcm/contracts";
import { Modal } from "./Modal";
import { formatBytes } from "../lib/format";

/**
 * Pre-upload conflict dialog raised by the conflict probe. Resolves to the
 * chosen policy, or null when the operator cancels the upload entirely.
 */
export function UploadConflictModal({
  conflict,
  onChoose,
}: {
  conflict: UploadConflict;
  onChoose: (policy: UploadConflictPolicy | null) => void;
}) {
  const name = conflict.path.split("/").pop() ?? conflict.path;
  return (
    <Modal ariaLabel="Upload conflict" onClose={() => onChoose(null)}>
      <h2>File already exists</h2>
      <p className="muted">
        <strong>{name}</strong> already holds {formatBytes(conflict.existingBytes)}.
        {conflict.partial ? " It looks like an interrupted upload of this same file." : ""}
      </p>
      <div className="actions">
        <button onClick={() => onChoose("replace")}>{conflict.partial ? "Resume" : "Replace"}</button>
        {conflict.canKeepBoth && <button onClick={() => onChoose("keep_both")}>Keep Both</button>}
        <button className="ghost" onClick={() => onChoose(null)}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
