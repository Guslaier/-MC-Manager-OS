// Shared, side-effect-free display formatters. Kept dependency-free so any
// page, tab or component can use them without pulling in extra runtime weight.

/** Local clock time for a console line timestamp. */
export function formatClock(at: string | number | Date): string {
  return new Date(at).toLocaleTimeString();
}

/** Full local date-time, used for server metadata rows. */
export function formatDateTime(at: string | number | Date): string {
  return new Date(at).toLocaleString();
}

/**
 * Human-readable byte size. Sub-KiB sizes stay as raw bytes so file listings
 * with tiny files still read exactly as before.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Shown for a metric that truly has no backing source. Never 0, never a bare dash. */
export const UNAVAILABLE_TEXT = "Unavailable (no source)";

/**
 * Render a possibly-absent metric. An absent value (null/undefined/NaN) always becomes the
 * explicit `UNAVAILABLE_TEXT` label so a missing sample can never be mistaken for a real 0;
 * a present value is delegated to `render`.
 */
export function formatMetricOrUnavailable<T>(
  value: T | null | undefined,
  render: (value: T) => string,
): string {
  if (value == null) return UNAVAILABLE_TEXT;
  if (typeof value === "number" && !Number.isFinite(value)) return UNAVAILABLE_TEXT;
  return render(value);
}

/**
 * One-line provenance for a sampled metric, e.g. `source: walk · sampled 1/2/2026, 3:04:05 PM`.
 * Returns an empty string when neither a source nor a valid timestamp is known.
 */
export function formatProvenance(source?: string | null, sampledAt?: string | null): string {
  const parts: string[] = [];
  if (source) parts.push(`source: ${source}`);
  if (sampledAt) {
    const at = new Date(sampledAt);
    if (!Number.isNaN(at.getTime())) parts.push(`sampled ${at.toLocaleString()}`);
  }
  return parts.join(" · ");
}

/** A metric cell's display text plus the provenance to expose through `title`/`aria-label`. */
export interface MetricDisplay {
  text: string;
  title: string;
}

/**
 * Storage cell text + provenance from a metrics sample. Used bytes come from the backend's
 * directory walk; file count and volume free/total come from the same sample. When no walk or
 * statfs result exists the cell stays an honest "unavailable" label instead of a fake 0.
 */
export function describeStorage(
  metrics:
    | {
        storageUsedBytes?: number | null;
        storageFiles?: number | null;
        storageFreeBytes?: number | null;
        storageTotalBytes?: number | null;
        storageSource?: "walk" | "statfs" | null;
        sampledAt?: string | null;
      }
    | null
    | undefined,
): MetricDisplay {
  const used = metrics?.storageUsedBytes ?? null;
  if (used == null) {
    return {
      text: UNAVAILABLE_TEXT,
      title: "No storage walk or statfs result was available for this sample",
    };
  }
  const details: string[] = [];
  const provenance = formatProvenance(metrics?.storageSource, metrics?.sampledAt);
  if (provenance) details.push(provenance);
  if (metrics?.storageFiles != null) details.push(`${metrics.storageFiles} files`);
  if (metrics?.storageFreeBytes != null && metrics?.storageTotalBytes != null) {
    details.push(`volume free ${formatBytes(metrics.storageFreeBytes)} of ${formatBytes(metrics.storageTotalBytes)}`);
  }
  return { text: formatBytes(used), title: details.join(" · ") };
}

/**
 * Chunk cell text + provenance from a region-header scan. A null count means the scan found no
 * region files, which is reported honestly rather than as 0 chunks.
 */
export function describeChunks(
  dimension: { chunks?: number | null; chunksSource?: "region-header" | null } | null | undefined,
): MetricDisplay {
  const chunks = dimension?.chunks ?? null;
  if (chunks == null) {
    return { text: UNAVAILABLE_TEXT, title: "No region-header scan result for this dimension" };
  }
  return { text: String(chunks), title: formatProvenance(dimension?.chunksSource) };
}
