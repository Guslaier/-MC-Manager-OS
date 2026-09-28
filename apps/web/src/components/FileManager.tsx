import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  ArchiveTask,
  ExtractConflictPolicy,
  FileEntry,
  UploadConflict,
  UploadConflictPolicy,
} from "@mcm/contracts";
import { api, describeError } from "../api";
import { formatBytes } from "../lib/format";
import { runUpload, type UploadTask } from "../lib/uploadManager";
import { ArchiveManager } from "./ArchiveManager";
import { ErrorText } from "./Feedback";
import { ExtractionConfirmModal } from "./ExtractionConfirmModal";
import { UploadConflictModal } from "./UploadConflictModal";
import { UploadManager } from "./UploadManager";

/** One directory node of the lazy tree: entries are fetched on first expand. */
interface DirState {
  entries: FileEntry[] | null;
  expanded: boolean;
  loading: boolean;
}

/** An open tab's text buffer plus its unsaved flag. */
interface OpenBuffer {
  content: string;
  dirty: boolean;
}

const EXT_ICON: Record<string, { codicon: string; tone: string }> = {
  java: { codicon: "file-code", tone: "java" },
  jar: { codicon: "file-zip", tone: "jar" },
  json: { codicon: "json", tone: "json" },
  yml: { codicon: "list-unordered", tone: "yml" },
  yaml: { codicon: "list-unordered", tone: "yml" },
  properties: { codicon: "settings-gear", tone: "conf" },
  conf: { codicon: "settings-gear", tone: "conf" },
  cfg: { codicon: "settings-gear", tone: "conf" },
  ini: { codicon: "settings-gear", tone: "conf" },
  sh: { codicon: "terminal", tone: "sh" },
  md: { codicon: "markdown", tone: "md" },
  log: { codicon: "output", tone: "log" },
  txt: { codicon: "note", tone: "txt" },
};

/** File-type Codicon by extension - plain token lookup over @vscode/codicons. */
function iconFor(name: string, isDir: boolean): { codicon: string; tone: string } {
  if (isDir) return { codicon: "folder", tone: "dir" };
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return EXT_ICON[ext] ?? { codicon: "file", tone: "file" };
}

/** Explorer order: directories first, then files, natural case-insensitive A-Z. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.type === "dir") - Number(a.type === "dir") ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

/** Extensions the server-side extractor accepts (`.jar` is deliberately excluded). */
function isArchiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz")
  );
}

/** View 3: VS Code Dark+ style file manager - explorer tree, tabs, line-numbered editor. */
export function FileManager({ scope, serverId }: { scope: string; serverId?: string }) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [selectedDir, setSelectedDir] = useState(scope);
  const [error, setError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, OpenBuffer>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [pending, setPending] = useState<{ file: File; dirPath: string; conflict: UploadConflict } | null>(null);
  const [wrap, setWrap] = useState(false);
  const [archives, setArchives] = useState<ArchiveTask[]>([]);
  const [pendingExtract, setPendingExtract] = useState<{ path: string; destination: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const controllers = useRef<Record<string, AbortController>>({});
  const tasksRef = useRef<Record<string, UploadTask>>({});
  const pollers = useRef<Record<string, number>>({});
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  function join(base: string, name: string) {
    return base === "." ? name : `${base}/${name}`;
  }

  function parent(p: string) {
    const parts = p.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/") || ".";
  }

  const loadDir = useCallback(
    async (p: string, expand = true) => {
      setError(null);
      setDirs((d) => ({ ...d, [p]: { entries: d[p]?.entries ?? null, expanded: expand, loading: true } }));
      try {
        const listing = await api.listFiles(p, serverId);
        setDirs((d) => ({ ...d, [listing.path]: { entries: listing.entries, expanded: true, loading: false } }));
      } catch (err) {
        setError(describeError(err));
        setDirs((d) => ({ ...d, [p]: { entries: [], expanded: true, loading: false } }));
      }
    },
    [serverId],
  );

  // A new scope resets the whole session: tree, tabs and buffers all belong to the old root.
  useEffect(() => {
    setDirs({});
    setTabs([]);
    setActive(null);
    setBuffers({});
    setArchives([]);
    setNotice(null);
    setSelectedDir(scope);
    void loadDir(scope);
  }, [scope, serverId, loadDir]);

  // Poll timers must not outlive the view, or a late tick would set state on a dead tree.
  useEffect(() => {
    const timers = pollers.current;
    return () => {
      for (const t of Object.values(timers)) window.clearTimeout(t);
    };
  }, []);

  function toggleDir(p: string) {
    setSelectedDir(p);
    setMenu(null);
    if (dirs[p]?.expanded) setDirs((d) => ({ ...d, [p]: { ...d[p], expanded: false } }));
    else void loadDir(p, true);
  }

  function refreshAll() {
    for (const p of Object.keys(dirs)) if (dirs[p]?.expanded) void loadDir(p, true);
  }

  function collapseAll() {
    setSelectedDir(scope);
    setDirs((d) => {
      const next: Record<string, DirState> = {};
      for (const k of Object.keys(d)) next[k] = { ...d[k], expanded: k === scope };
      return next;
    });
  }

  async function openFile(full: string) {
    setMenu(null);
    setTabs((t) => (t.includes(full) ? t : [...t, full]));
    setActive(full);
    if (buffers[full]) return; // keep any unsaved edits already held for this path
    setError(null);
    try {
      const file = await api.readFile(full, serverId);
      setBuffers((b) => ({ ...b, [full]: { content: file.content, dirty: false } }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  function closeTab(path: string) {
    if (buffers[path]?.dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
    const rest = tabs.filter((t) => t !== path);
    setTabs(rest);
    setBuffers((b) => omit(b, path));
    setActive((a) => (a === path ? (rest[rest.length - 1] ?? null) : a));
  }

  /** Closes every tab at or under a deleted path. */
  function closeUnder(prefix: string) {
    const removed = tabs.filter((t) => t === prefix || t.startsWith(`${prefix}/`));
    if (removed.length === 0) return;
    const rest = tabs.filter((t) => !removed.includes(t));
    setTabs(rest);
    setBuffers((b) => {
      let next = b;
      for (const t of removed) next = omit(next, t);
      return next;
    });
    setActive((a) => (a && removed.includes(a) ? (rest[rest.length - 1] ?? null) : a));
  }

  async function save() {
    if (!active || !buffers[active]) return;
    setError(null);
    try {
      await api.writeFile({ path: active, content: buffers[active].content }, serverId);
      setBuffers((b) => ({ ...b, [active]: { ...b[active], dirty: false } }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function remove(full: string, dirPath: string) {
    setMenu(null);
    if (!confirm(`Delete ${full}? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteFile(full, serverId);
      closeUnder(full);
      void loadDir(dirPath, dirs[dirPath]?.expanded ?? true);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function rename(full: string, name: string, dirPath: string) {
    setMenu(null);
    const next = window.prompt(`Rename ${name} to:`, name);
    if (!next || next === name) return;
    const dir = parent(full);
    const target = dir === "." ? next : `${dir}/${next}`;
    setError(null);
    api
      .renameEntry(full, target, serverId)
      .then(() => {
        // Follow the file: move its tab and buffer to the new path.
        setTabs((t) => t.map((x) => (x === full ? target : x)));
        setBuffers((b) => (b[full] ? { ...omit(b, full), [target]: b[full] } : b));
        setActive((a) => (a === full ? target : a));
        void loadDir(dirPath, dirs[dirPath]?.expanded ?? true);
      })
      .catch((err) => setError(describeError(err)));
  }

  async function createFile() {
    const name = window.prompt(`New file in ${selectedDir}:`);
    if (!name) return;
    const target = join(selectedDir, name);
    setError(null);
    try {
      await api.writeFile({ path: target, content: "" }, serverId);
      void loadDir(selectedDir, true);
    } catch (err) {
      setError(describeError(err));
    }
  }

  /** Keeps the panel list and the id->task lookup in sync for one upload. */
  function updateTask(id: string, patch: Partial<UploadTask>) {
    const base = tasksRef.current[id];
    if (!base) return;
    const next = { ...base, ...patch };
    tasksRef.current[id] = next;
    setUploads((list) => list.map((t) => (t.id === id ? next : t)));
  }

  /** Drops a finished task from the panel after a short delay. */
  function scheduleRemove(id: string) {
    window.setTimeout(() => {
      delete tasksRef.current[id];
      setUploads((list) => list.filter((t) => t.id !== id));
    }, 4000);
  }

  /**
   * Creates the panel entry, runs the cancellable chunk loop, then applies cancel
   * cleanup. Percentages come from bytes the server confirmed it stored (never a
   * synthetic timer), and a cancelled upload only deletes a file it started from 0,
   * so a pre-existing file is never destroyed.
   */
  function runTask(file: File, dirPath: string, resumeFrom: number, policy: UploadConflictPolicy | undefined) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const task: UploadTask = {
      id,
      name: file.name,
      path: join(dirPath, file.name),
      fileSize: file.size,
      uploadedBytes: resumeFrom,
      resumeFrom,
      preexistingBytes: resumeFrom,
      status: "uploading",
      error: null,
    };
    const controller = new AbortController();
    controllers.current[id] = controller;
    tasksRef.current[id] = task;
    setUploads((list) => [...list, task]);
    void runUpload({
      file,
      dirPath,
      serverId,
      policy,
      resumeFrom,
      signal: controller.signal,
      onProgress: (uploadedBytes, path) => updateTask(id, { uploadedBytes, path }),
    })
      .then(() => {
        updateTask(id, { status: "done", uploadedBytes: file.size });
        scheduleRemove(id);
        void loadDir(dirPath, dirs[dirPath]?.expanded ?? true);
      })
      .catch(async (err: unknown) => {
        if (controller.signal.aborted) {
          if (task.preexistingBytes === 0) {
            try {
              await api.uploadAbort(tasksRef.current[id]?.path ?? task.path, serverId);
            } catch {
              // Cleanup is best-effort; a leftover partial file stays resumable.
            }
          }
          updateTask(id, { status: "cancelled" });
          scheduleRemove(id);
        } else {
          updateTask(id, { status: "error", error: describeError(err) });
        }
      })
      .finally(() => {
        delete controllers.current[id];
      });
  }

  /** Probes the target first: an existing file opens the conflict modal, otherwise upload starts. */
  async function startUpload(file: File, dirPath: string) {
    setError(null);
    try {
      const conflict = await api.uploadConflict(join(dirPath, file.name), file.size, serverId);
      if (conflict.exists) {
        setPending({ file, dirPath, conflict });
        return;
      }
      runTask(file, dirPath, conflict.existingBytes, undefined);
    } catch (err) {
      setError(describeError(err));
    }
  }

  function chooseConflict(policy: UploadConflictPolicy | null) {
    const p = pending;
    setPending(null);
    if (!p || !policy) return;
    // Resuming only makes sense for an interrupted upload of this same file.
    const resumeFrom = policy === "replace" && p.conflict.partial ? p.conflict.existingBytes : 0;
    runTask(p.file, p.dirPath, resumeFrom, policy);
  }

  function cancelUpload(id: string) {
    controllers.current[id]?.abort();
  }

  /**
   * True while a running extraction owns this path (or a parent of it), so the
   * tree refuses rename/delete on entries the extractor is actively writing.
   */
  function busyUnder(full: string): boolean {
    return archives.some(
      (t) =>
        t.status === "extracting" &&
        (t.destination === full ||
          full.startsWith(`${t.destination}/`) ||
          t.destination.startsWith(`${full}/`)),
    );
  }

  /** Polls one extraction until it leaves `extracting`, then refreshes the tree. */
  function pollTask(id: string) {
    const tick = async () => {
      try {
        const task = await api.archiveTask(id);
        setArchives((list) => list.map((t) => (t.id === id ? task : t)));
        if (task.status === "extracting") {
          pollers.current[id] = window.setTimeout(() => void tick(), 700);
          return;
        }
        delete pollers.current[id];
        if (task.status === "done") {
          const skipped = task.skippedEntries > 0 ? `, ${task.skippedEntries} skipped` : "";
          setNotice(`Extracted ${task.extractedEntries} file(s) into ${task.destination}${skipped}.`);
          // Refresh the destination and its parent: a new top-level folder must appear.
          void loadDir(task.destination, true);
          const up = parent(task.destination);
          if (up !== task.destination) void loadDir(up, dirs[up]?.expanded ?? true);
        } else {
          setError(task.error ?? "Extraction failed.");
        }
        window.setTimeout(() => setArchives((list) => list.filter((t) => t.id !== id)), 6000);
      } catch (err) {
        delete pollers.current[id];
        setError(describeError(err));
      }
    };
    void tick();
  }

  function extractHere(full: string) {
    setMenu(null);
    setNotice(null);
    setPendingExtract({ path: full, destination: parent(full) });
  }

  /** Starts the background extraction; the panel shows progress until it settles. */
  async function chooseExtractPolicy(policy: ExtractConflictPolicy | null) {
    const p = pendingExtract;
    setPendingExtract(null);
    if (!p || !policy) return;
    setError(null);
    try {
      const task = await api.extractArchive(p.path, policy, serverId, p.destination);
      setArchives((list) => [...list, task]);
      pollTask(task.id);
    } catch (err) {
      setError(describeError(err));
    }
  }

  /** Streams the folder as a ZIP from the server, then hands the blob to the browser. */
  async function downloadZip(full: string) {
    setMenu(null);
    setError(null);
    const name = full.split("/").pop() ?? "folder";
    setNotice(`Preparing ${name}.zip …`);
    try {
      const res = await api.downloadFolderZip(full, serverId);
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Downloaded ${name}.zip (${formatBytes(blob.size)}).`);
    } catch (err) {
      setNotice(null);
      setError(describeError(err));
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    for (const file of Array.from(e.dataTransfer.files)) void startUpload(file, selectedDir);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void startUpload(file, selectedDir);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  }

  /** Keeps the fixed gutter aligned with the textarea's vertical scroll. */
  function syncScroll() {
    if (textRef.current && gutterRef.current) gutterRef.current.scrollTop = textRef.current.scrollTop;
  }

  function treeRow(entry: FileEntry, dirPath: string, depth: number): ReactElement {
    const full = join(dirPath, entry.name);
    const isDir = entry.type === "dir";
    const st = dirs[full];
    const isActive = active === full;
    const isSelected = isDir && selectedDir === full;
    const ico = iconFor(entry.name, isDir);
    return (
      <li key={full} className="fm-node">
        <div
          className={`fm-row${isActive ? " active" : ""}${isSelected ? " selected" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          <button
            className="fm-row-main"
            role="treeitem"
            aria-expanded={isDir ? Boolean(st?.expanded) : undefined}
            aria-selected={isDir ? isSelected : isActive}
            onClick={() => (isDir ? toggleDir(full) : void openFile(full))}
          >
            <span
              className={`fm-caret${isDir ? ` codicon codicon-chevron-right${st?.expanded ? " open" : ""}` : ""}`}
              aria-hidden="true"
            />
            <span
              className={`fm-ico fm-ico-${ico.tone} codicon codicon-${ico.codicon}`}
              aria-hidden="true"
            />
            <span className="fm-name">{entry.name}</span>
            {entry.type === "file" && <span className="fm-size">{formatBytes(entry.sizeBytes)}</span>}
          </button>
          {isDir && st?.loading && (
            <span className="fm-spin" aria-hidden="true">
              …
            </span>
          )}
          <button
            className="fm-menu-btn"
            aria-label={`Actions for ${entry.name}`}
            onClick={() => setMenu(menu === full ? null : full)}
          >
            <span className="codicon codicon-ellipsis" aria-hidden="true" />
          </button>
          {menu === full && (
            <div className="menu">
              {isDir && <button onClick={() => void downloadZip(full)}>Download as .zip</button>}
              {!isDir && isArchiveName(entry.name) && (
                <button onClick={() => extractHere(full)}>Extract here…</button>
              )}
              <button disabled={busyUnder(full)} onClick={() => rename(full, entry.name, dirPath)}>
                Rename
              </button>
              <button className="danger" disabled={busyUnder(full)} onClick={() => void remove(full, dirPath)}>
                Delete
              </button>
            </div>
          )}
        </div>
      </li>
    );
  }

  function renderDir(dirPath: string, depth: number): ReactElement[] {
    const st = dirs[dirPath];
    if (!st?.entries) return [];
    const out: ReactElement[] = [];
    for (const entry of sortEntries(st.entries)) {
      out.push(treeRow(entry, dirPath, depth));
      if (entry.type === "dir") {
        const child = join(dirPath, entry.name);
        if (dirs[child]?.expanded) out.push(...renderDir(child, depth + 1));
      }
    }
    return out;
  }

  const buffer = active ? buffers[active] : null;
  const lineCount = buffer ? buffer.content.split("\n").length : 0;
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
  const crumbs = active ? active.split("/").filter(Boolean) : [];

  return (
    <div
      className="fm"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <aside className="fm-tree">
        <div className="fm-explorer-head">
          <span className="fm-explorer-title">Explorer</span>
          <span className="spacer" />
          <button className="fm-iconbtn" title="New file" aria-label="New file" onClick={createFile}>
            <span className="codicon codicon-new-file" aria-hidden="true" />
          </button>
          <button className="fm-iconbtn" title="Refresh" aria-label="Refresh tree" onClick={refreshAll}>
            <span className="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button className="fm-iconbtn" title="Collapse all" aria-label="Collapse all" onClick={collapseAll}>
            <span className="codicon codicon-collapse-all" aria-hidden="true" />
          </button>
          <label className="fm-iconbtn" title="Upload file" aria-label="Upload file">
            <span className="codicon codicon-cloud-upload" aria-hidden="true" />
            <input type="file" onChange={onPick} hidden />
          </label>
        </div>
        <div className="fm-scope" title={selectedDir}>
          {selectedDir}
        </div>
        <ul className="fm-list" role="tree" aria-label="File tree">
          {renderDir(scope, 0)}
          {dirs[scope]?.loading && <li className="muted fm-empty">Loading…</li>}
          {dirs[scope] && !dirs[scope].loading && (dirs[scope].entries?.length ?? 0) === 0 && (
            <li className="muted fm-empty">Empty directory.</li>
          )}
        </ul>
      </aside>

      <section className="fm-editor">
        <div className="fm-tabs" role="tablist" aria-label="Open files">
          {tabs.map((t) => {
            const name = t.split("/").pop() ?? t;
            const dirty = buffers[t]?.dirty;
            return (
              <div key={t} className={`fm-tab${active === t ? " active" : ""}`} role="tab" aria-selected={active === t}>
                <button className="fm-tab-label" title={t} onClick={() => setActive(t)}>
                  <span
                    className={`fm-ico fm-ico-${iconFor(name, false).tone} codicon codicon-${
                      iconFor(name, false).codicon
                    }`}
                    aria-hidden="true"
                  />
                  {name}
                  {dirty && (
                    <span className="fm-dot" aria-label="unsaved">
                      •
                    </span>
                  )}
                </button>
                <button className="fm-tab-close" aria-label={`Close ${name}`} onClick={() => closeTab(t)}>
                  <span className="codicon codicon-close" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        <ErrorText message={error} />
        {notice && <p className="am-notice">{notice}</p>}

        {active && buffer ? (
          <>
            <div className="fm-toolbar">
              <nav className="fm-breadcrumb" aria-label="Current file path">
                {crumbs.map((seg, i) => (
                  <span key={i}>
                    {seg}
                    {i < crumbs.length - 1 && <span className="fm-crumb-sep">›</span>}
                  </span>
                ))}
              </nav>
              <span className="spacer" />
              <button className="ghost" onClick={() => setWrap((w) => !w)}>
                {wrap ? "No wrap" : "Wrap"}
              </button>
              {buffer.dirty && <span className="state stopped">unsaved</span>}
              <button onClick={save} disabled={!buffer.dirty}>
                Save
              </button>
            </div>
            <div className="fm-code">
              <pre className="fm-gutter" ref={gutterRef} aria-hidden="true">
                {gutter}
              </pre>
              <textarea
                ref={textRef}
                className="fm-text"
                aria-label="File content"
                wrap={wrap ? "soft" : "off"}
                spellCheck={false}
                value={buffer.content}
                onChange={(e) => setBuffers((b) => ({ ...b, [active]: { content: e.target.value, dirty: true } }))}
                onKeyDown={onKeyDown}
                onScroll={syncScroll}
              />
            </div>
          </>
        ) : (
          <p className="muted pad">
            Select a file in the explorer to edit, or drop files here to upload to {selectedDir}.
          </p>
        )}
      </section>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">Drop files to upload to {selectedDir}</div>
        </div>
      )}

      <UploadManager tasks={uploads} onCancel={cancelUpload} />
      <ArchiveManager tasks={archives} />
      {pending && <UploadConflictModal conflict={pending.conflict} onChoose={chooseConflict} />}
      {pendingExtract && (
        <ExtractionConfirmModal
          archivePath={pendingExtract.path}
          destination={pendingExtract.destination}
          onChoose={chooseExtractPolicy}
        />
      )}
    </div>
  );
}
