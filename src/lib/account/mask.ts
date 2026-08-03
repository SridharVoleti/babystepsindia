// IA-003 security note: mask old and new emails in general logs/support
// views (personal data). Keeps the first local-part character and the
// full domain (domains aren't the identifying secret here).
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "—";

  const atIndex = email.indexOf("@");
  if (atIndex <= 0) return "•".repeat(email.length);

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  if (local.length <= 1) return `${local}@${domain}`;

  return `${local[0]}${"•".repeat(local.length - 1)}@${domain}`;
}
