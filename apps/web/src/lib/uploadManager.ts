import type { UploadConflictPolicy } from "@mcm/contracts";
import { api } from "../api";

/** Size of one upload chunk; kept small so a chunk fits comfortably in memory. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/** Live state of one queued upload, rendered by the sticky UploadManager panel. */
export interface UploadTask {
  id: string;
  name: string;
  /** Current destination path; the server rewrites it when the `keep_both` policy renames the file. */
  path: string;
  fileSize: number;
  uploadedBytes: number;
  /** Bytes already stored at the path when this upload began (a resume offset). */
  resumeFrom: number;
  /** Bytes that existed before this upload started, so cancel can tell a partial file from a real one. */
  preexistingBytes: number;
  status: "uploading" | "done" | "error" | "cancelled";
  error: string | null;
}

/**
 * Streams one file to the scoped upload endpoint in 1 MiB chunks. Offsets are
 * strictly sequential - the byte count the server confirms it stored drives the
 * next offset, so there is no fake progress and a retry can never overwrite
 * earlier bytes. Aborts between chunks when `signal` fires.
 *
 * The conflict policy is sent only with the first chunk: `keep_both` triggers a
 * server-side rename that the response echoes back, and re-sending it on every
 * chunk would rename again and split the file.
 */
export async function runUpload(opts: {
  file: File;
  dirPath: string;
  serverId?: string;
  policy?: UploadConflictPolicy;
  resumeFrom: number;
  onProgress: (uploadedBytes: number, path: string) => void;
  signal: AbortSignal;
}): Promise<void> {
  const { file, dirPath, serverId, policy, resumeFrom, onProgress, signal } = opts;
  const initial = dirPath === "." ? file.name : `${dirPath}/${file.name}`;
  let path = initial;
  let offset = resumeFrom;
  onProgress(offset, path);
  while (offset < file.size) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const chunk = file.slice(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, file.size));
    const firstChunk = offset === resumeFrom && offset === 0;
    const result = await api.uploadChunk(path, chunk, offset, serverId, firstChunk ? policy : undefined);
    path = result.path;
    offset = result.totalBytes;
    onProgress(offset, path);
  }
}
