export type PivotResult = {
  periods: string[];
  columns: string[];
  matrix: Record<string, Record<string, number>>;
  totalsByProduct: Record<string, number>;
  grandTotal: number;
};

export function pivotByPeriodAndProduct<
  T extends { period: string; productSlug: string },
>(rows: T[], valueKey: keyof T, productOrder: string[]): PivotResult {
  const periodsSet = new Set<string>();
  const matrix: Record<string, Record<string, number>> = {};
  const totalsByProduct: Record<string, number> = {};
  let grandTotal = 0;

  for (const row of rows) {
    periodsSet.add(row.period);
    matrix[row.period] ??= {};
    const value = Number(row[valueKey]);
    matrix[row.period][row.productSlug] = value;
    totalsByProduct[row.productSlug] = (totalsByProduct[row.productSlug] ?? 0) + value;
    grandTotal += value;
  }

  const periods = Array.from(periodsSet).sort();
  const presentColumns = new Set(rows.map((r) => r.productSlug));
  const columns = productOrder.filter((c) => presentColumns.has(c));

  return { periods, columns, matrix, totalsByProduct, grandTotal };
}
