export function formatINR(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

// Hand-rolled Indian-numbering compaction (K / L / Cr). Intl's
// notation: "compact" for en-IN mislabels the thousands tier as "T" on the
// ICU data bundled with this Node build (1,299 -> "1.3T", reading as
// trillion) — wrong by many orders of magnitude on a revenue dashboard, so
// this sidesteps that path entirely rather than trusting it.
function compactSuffix(n: number): { scaled: number; suffix: string } | null {
  const abs = Math.abs(n);
  if (abs >= 1_00_00_000) return { scaled: n / 1_00_00_000, suffix: "Cr" };
  if (abs >= 1_00_000) return { scaled: n / 1_00_000, suffix: "L" };
  if (abs >= 1_000) return { scaled: n / 1_000, suffix: "K" };
  return null;
}

export function formatCompactINR(amount: number): string {
  const compact = compactSuffix(amount);
  if (!compact) return formatINR(amount);
  return `₹${compact.scaled.toFixed(1)}${compact.suffix}`;
}

export function formatCompactNumber(n: number): string {
  const compact = compactSuffix(n);
  if (!compact) return new Intl.NumberFormat("en-IN").format(n);
  return `${compact.scaled.toFixed(1)}${compact.suffix}`;
}
