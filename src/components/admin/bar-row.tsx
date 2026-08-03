// Sequential, single-hue magnitude bar (dataviz: "compare magnitude" -> one
// hue, more-is-longer) — not categorical, since these rows are the same
// metric compared across products, not distinct series plotted together.
export function BarRow({
  label,
  value,
  displayValue,
  maxValue,
}: {
  label: string;
  value: number;
  displayValue: string;
  maxValue: number;
}) {
  const pct =
    maxValue > 0 ? Math.max((value / maxValue) * 100, value > 0 ? 2 : 0) : 0;

  return (
    <div className="flex items-center gap-3">
      <span className="w-36 shrink-0 truncate text-sm text-chakra-700">
        {label}
      </span>
      <div className="h-4 flex-1 overflow-hidden rounded-full bg-chakra-50">
        <div
          className="h-full rounded-full bg-green-600"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums text-chakra-900">
        {displayValue}
      </span>
    </div>
  );
}
