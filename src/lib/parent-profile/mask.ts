// IA-002 security note: mask numbers in logs and administration screens.
// Keeps the leading "+" and the last two digits; everything else becomes
// a bullet so support/admin views can confirm a number without seeing it.
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "—";

  const digits = e164.replace(/^\+/, "");
  if (digits.length <= 2) {
    return `+${"•".repeat(digits.length)}`;
  }

  const visible = digits.slice(-2);
  return `+${"•".repeat(digits.length - 2)}${visible}`;
}
