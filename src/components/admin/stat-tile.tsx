export function StatTile({
  label,
  value,
  deltaPercent,
}: {
  label: string;
  value: string;
  deltaPercent?: number | null;
}) {
  const hasDelta = deltaPercent !== undefined && deltaPercent !== null;
  const isUp = hasDelta && deltaPercent! >= 0;

  return (
    <div className="card p-5">
      <p className="text-sm text-chakra-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-chakra-900">{value}</p>
      {hasDelta && (
        <p
          className={`mt-1 text-sm font-medium ${isUp ? "text-green-700" : "text-saffron-700"}`}
        >
          {isUp ? "▲" : "▼"} {Math.abs(deltaPercent!).toFixed(1)}% vs previous
          period
        </p>
      )}
    </div>
  );
}
