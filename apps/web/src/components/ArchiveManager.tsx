import type { ArchiveTask } from "@mcm/contracts";
import { formatBytes } from "../lib/format";

/**
 * Sticky bottom-left panel listing archive extractions, mirroring `.um-*`.
 * Progress is entry-based (what the server confirmed it wrote), never a timer;
 * finished/errored tasks are dismissed by the caller after a short delay.
 */
export function ArchiveManager({ tasks }: { tasks: ArchiveTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="am-panel" role="region" aria-label="Active extractions">
      <div className="am-head">
        <span className="am-title">Extractions ({tasks.length})</span>
      </div>
      <ul className="am-list">
        {tasks.map((task) => {
          const total = task.totalEntries || 1;
          const pct = Math.min(100, Math.round((task.extractedEntries / total) * 100));
          const tone = task.status === "error" ? "error" : task.status === "done" ? "done" : "";
          const name = task.path.split("/").pop() ?? task.path;
          return (
            <li key={task.id} className="am-item">
              <div className="am-name" title={task.path}>
                {name}
              </div>
              <div className="am-bar">
                <div className={`am-bar-fill ${tone}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="am-meta">
                <span className="am-pct">
                  {task.status === "done"
                    ? task.skippedEntries > 0
                      ? `Done (${task.skippedEntries} skipped)`
                      : "Done"
                    : task.status === "error"
                      ? "Failed"
                      : `${pct}%`}
                </span>
                <span className="muted">
                  {task.extractedEntries}/{task.totalEntries} files · {formatBytes(task.bytesWritten)}
                </span>
                <span className="spacer" />
                <span className="muted am-fmt">{task.format}</span>
              </div>
              {task.error && <p className="error am-err">{task.error}</p>}
              {!task.error && task.warnings.length > 0 && (
                <p className="muted am-warn">{task.warnings.length} entr{task.warnings.length === 1 ? "y" : "ies"} rejected</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
