/** Labelled progress bar for the CPU / RAM metrics (pure CSS, no chart dependency). */
export function UsageBar({
  label,
  percent,
  tone,
}: {
  label: string;
  percent: number;
  tone: "cpu" | "ram" | "muted" | "warn" | "danger";
}) {
  const width = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="bar-wrap" title={label}>
      <div className="bar">
        <div className={`bar-fill ${tone}`} style={{ width: `${width}%` }} />
      </div>
      <span className="bar-label">{label}</span>
    </div>
  );
}
