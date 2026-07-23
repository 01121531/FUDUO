export function Metric({
  label,
  value,
  change,
  direction = "neutral",
}: {
  label: string;
  value: string;
  change: string;
  direction?: "positive" | "negative" | "neutral";
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className={`kpi-change ${direction}`}>{change}</div>
    </div>
  );
}
