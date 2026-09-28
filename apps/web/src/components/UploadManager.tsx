import { formatBytes } from "../lib/format";
import type { UploadTask } from "../lib/uploadManager";

/**
 * Sticky bottom-right panel listing active uploads with honest byte progress and
 * a Cancel button. Percentages come from bytes the server confirmed it stored,
 * never from a synthetic timer. Pure CSS, no new dependency.
 */
export function UploadManager({ tasks, onCancel }: { tasks: UploadTask[]; onCancel: (id: string) => void }) {
  if (tasks.length === 0) return null;
  return (
    <div className="um-panel" role="region" aria-label="Active uploads">
      <div className="um-head">
        <span className="um-title">Uploads ({tasks.length})</span>
      </div>
      <ul className="um-list">
        {tasks.map((task) => {
          const total = task.fileSize || 1;
          const pct = Math.min(100, Math.round((task.uploadedBytes / total) * 100));
          const tone = task.status === "error" ? "error" : task.status === "done" ? "done" : "";
          return (
            <li key={task.id} className="um-item">
              <div className="um-name" title={task.path}>
                {task.name}
              </div>
              <div className="um-bar">
                <div className={`um-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="um-meta">
                <span className="um-pct">{task.status === "done" ? "Done" : `${pct}%`}</span>
                <span className="muted">
                  {formatBytes(task.uploadedBytes)} / {formatBytes(task.fileSize)}
                </span>
                <span className="spacer" />
                {task.status === "uploading" && (
                  <button className="ghost um-cancel" onClick={() => onCancel(task.id)}>
                    Cancel
                  </button>
                )}
              </div>
              {task.error && <p className="error um-err">{task.error}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
