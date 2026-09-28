import type { ExtractConflictPolicy } from "@mcm/contracts";
import { Modal } from "./Modal";

/**
 * Pre-extraction confirmation dialog. Defaults to `overwrite` (Enter / primary
 * button) but always offers `skip` so collisions never destroy data silently.
 * Resolves to the chosen policy, or null when the operator cancels.
 */
export function ExtractionConfirmModal({
  archivePath,
  destination,
  onChoose,
}: {
  archivePath: string;
  destination: string;
  onChoose: (policy: ExtractConflictPolicy | null) => void;
}) {
  const name = archivePath.split("/").pop() ?? archivePath;
  return (
    <Modal ariaLabel="Extract archive" onClose={() => onChoose(null)}>
      <h2>Extract archive</h2>
      <p className="muted">
        <strong>{name}</strong> will be extracted into <code>{destination}</code>.
      </p>
      <p className="muted">
        If an entry already exists: <strong>Overwrite</strong> replaces it, <strong>Skip</strong> keeps the
        existing file as-is.
      </p>
      <div className="actions">
        <button autoFocus onClick={() => onChoose("overwrite")}>
          Overwrite
        </button>
        <button onClick={() => onChoose("skip")}>Skip existing</button>
        <button className="ghost" onClick={() => onChoose(null)}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
