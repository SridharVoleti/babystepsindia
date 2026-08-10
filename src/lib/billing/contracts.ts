export const BILLING_CONSENT_DISCLOSURE_VERSION = "recurring-billing-v1";
export const BILLING_DEFAULT_CURRENCY = "INR";
export const BILLING_REMINDER_LEAD_MS = 168 * 60 * 60 * 1000;
export const BILLING_GRACE_DURATION_MS = 168 * 60 * 60 * 1000;

export function formatMinorAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount / 100);
}
