// Status colors are reserved (good/warning/critical) and kept separate from
// the brand/categorical palette used elsewhere in the dashboard.
const STATUS_STYLES: Record<string, string> = {
  active: "bg-green-50 text-green-700",
  cancelling: "bg-saffron-50 text-saffron-700",
  past_due: "bg-saffron-100 text-saffron-800",
  cancelled: "bg-chakra-100 text-chakra-600",
  expired: "bg-red-50 text-red-700",
};

export function StatusPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-chakra-300">—</span>;
  const style = STATUS_STYLES[status] ?? "bg-chakra-100 text-chakra-600";

  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {status}
    </span>
  );
}
