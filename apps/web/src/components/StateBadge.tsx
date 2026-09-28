export type StateTone = "running" | "stopped" | "muted";

/** Rounded pill with a tone dot; used for server state and live/offline indicators. */
export function StateBadge({ tone, label }: { tone: StateTone; label: string }) {
  return <span className={`state ${tone}`}>{label}</span>;
}
