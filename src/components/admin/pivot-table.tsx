import type { PivotResult } from "@/lib/admin/pivot";

export function PivotTable({
  pivot,
  productLabels,
  formatValue,
}: {
  pivot: PivotResult;
  productLabels: Record<string, string>;
  formatValue: (n: number) => string;
}) {
  if (pivot.periods.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-chakra-400">
        No data in this range.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-chakra-100 text-left text-xs font-medium uppercase tracking-wide text-chakra-400">
            <th className="py-2 pr-4">Period</th>
            {pivot.columns.map((col) => (
              <th key={col} className="py-2 pr-4 text-right">
                {productLabels[col] ?? col}
              </th>
            ))}
            <th className="py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-chakra-50">
          {pivot.periods.map((period) => {
            const row = pivot.matrix[period] ?? {};
            const rowTotal = pivot.columns.reduce(
              (sum, c) => sum + (row[c] ?? 0),
              0,
            );
            return (
              <tr key={period}>
                <td className="py-2 pr-4 font-medium text-chakra-700">
                  {period}
                </td>
                {pivot.columns.map((col) => (
                  <td
                    key={col}
                    className="py-2 pr-4 text-right tabular-nums text-chakra-900"
                  >
                    {formatValue(row[col] ?? 0)}
                  </td>
                ))}
                <td className="py-2 text-right font-medium tabular-nums text-chakra-900">
                  {formatValue(rowTotal)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-chakra-100 font-semibold text-chakra-900">
            <td className="py-2 pr-4">Total</td>
            {pivot.columns.map((col) => (
              <td key={col} className="py-2 pr-4 text-right tabular-nums">
                {formatValue(pivot.totalsByProduct[col] ?? 0)}
              </td>
            ))}
            <td className="py-2 text-right tabular-nums">
              {formatValue(pivot.grandTotal)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
