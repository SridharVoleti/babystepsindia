// IA-002: invoiceRecipientLabel — trimmed display_name when non-empty,
// otherwise the authenticated email. Invoice delivery address is always
// the authenticated email; this only affects the recipient label shown
// on the invoice itself.
export function invoiceRecipientLabel(
  displayName: string | null | undefined,
  authEmail: string,
): string {
  const trimmed = (displayName ?? "").trim();
  return trimmed.length > 0 ? trimmed : authEmail;
}

export type InvoiceRecipient = {
  label: string;
  deliveryEmail: string;
};

// Billing callers receive the authenticated address and computed label as
// one value so a profile-supplied address cannot accidentally become the
// invoice/receipt destination.
export function invoiceRecipient(
  displayName: string | null | undefined,
  authenticatedEmail: string,
): InvoiceRecipient {
  return {
    label: invoiceRecipientLabel(displayName, authenticatedEmail),
    deliveryEmail: authenticatedEmail,
  };
}
