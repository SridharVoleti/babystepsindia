import { getNotificationTypeDefinition, validateSafeVariables } from "@/lib/notifications/contracts";

export class NotificationTemplateError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "NotificationTemplateError"; }
}

export type RenderedNotification = { subject: string; text: string; html: string };

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const FOOTER_TEXT = "Babysteps — important account communication. Manage your account at /account.";
const FOOTER_HTML = `<p style="color:#666;font-size:12px;">Babysteps — important account communication. Manage your account at <a href="/account">/account</a>.</p>`;

type Renderer = (vars: Record<string, unknown>) => RenderedNotification;

// Rules 19-21/81: one renderer per approved type+version, structured safe
// variables only (never raw source-supplied HTML — rule 22/27), deterministic
// given the same version/variables (V1 has a single fallback locale, rule 81).
const RENDERERS: Record<string, Renderer> = {
  "billing_renewal_reminder@v1": (v) => ({
    subject: "Your Babysteps subscription renews soon",
    text: `Your ${v.subscriptionLabel} subscription renews on ${v.renewalDate} for ${v.currency} ${v.amount}.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> subscription renews on `
      + `${escapeHtml(String(v.renewalDate))} for ${escapeHtml(String(v.currency))} ${escapeHtml(String(v.amount))}.</p>`,
  }),
  "billing_grace_started@v1": (v) => ({
    subject: "We couldn't process your Babysteps payment",
    text: `Your ${v.subscriptionLabel} payment didn't go through. Please update your payment method before ${v.graceEndsAt}.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> payment didn't go through. `
      + `Please update your payment method before ${escapeHtml(String(v.graceEndsAt))}.</p>`,
  }),
  "billing_payment_recovered@v1": (v) => ({
    subject: "Your Babysteps payment was recovered",
    text: `Your ${v.subscriptionLabel} payment was successfully processed. Access continues normally.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> payment was successfully processed. `
      + `Access continues normally.</p>`,
  }),
  "billing_grace_expired@v1": (v) => ({
    subject: "Your Babysteps subscription access has ended",
    text: `Your ${v.subscriptionLabel} payment could not be recovered and access has ended.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> payment could not be recovered `
      + `and access has ended.</p>`,
  }),
  "subscription_cancellation_scheduled@v1": (v) => ({
    subject: "Your Babysteps cancellation is scheduled",
    text: `Your ${v.subscriptionLabel} subscription is scheduled to cancel. Access continues until ${v.accessEndsAt}.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> subscription is scheduled to cancel. `
      + `Access continues until ${escapeHtml(String(v.accessEndsAt))}.</p>`,
  }),
  "subscription_cancellation_reversed@v1": (v) => ({
    subject: "Your Babysteps cancellation was reversed",
    text: `Your ${v.subscriptionLabel} cancellation was reversed. Your subscription will continue to renew.`,
    html: `<p>Your <strong>${escapeHtml(String(v.subscriptionLabel))}</strong> cancellation was reversed. `
      + `Your subscription will continue to renew.</p>`,
  }),
  "billing_refund_outcome@v1": (v) => ({
    subject: "Your Babysteps refund update",
    text: `Your ${v.refundType} refund for ${v.subscriptionLabel} has been confirmed.`,
    html: `<p>Your <strong>${escapeHtml(String(v.refundType))}</strong> refund for `
      + `${escapeHtml(String(v.subscriptionLabel))} has been confirmed.</p>`,
  }),
  "account_email_changed@v1": () => ({
    subject: "Your Babysteps account email was changed",
    text: "The email address on your Babysteps account was changed. If you didn't make this change, contact support.",
    html: "<p>The email address on your Babysteps account was changed. If you didn't make this change, "
      + "contact support.</p>",
  }),
  "account_password_changed@v1": () => ({
    subject: "Your Babysteps account password was changed",
    text: "The password on your Babysteps account was changed. If you didn't make this change, contact support.",
    html: "<p>The password on your Babysteps account was changed. If you didn't make this change, "
      + "contact support.</p>",
  }),
  "invoice_receipt_available@v1": (v) => ({
    subject: "A new Babysteps document is available",
    text: `Your ${v.documentLabel} is available in your account.`,
    html: `<p>Your <strong>${escapeHtml(String(v.documentLabel))}</strong> is available in your account.</p>`,
  }),
  "approved_service_notice@v1": (v) => ({
    subject: String(v.noticeTitle),
    text: `${v.noticeTitle}`,
    html: `<p>${escapeHtml(String(v.noticeTitle))}</p>`,
  }),
};

// Rule 23-24/81-82: unknown type/version rejected before render; required
// variables validated; footer appended after the type-specific body so
// every transactional email carries the same neutral identity/support line
// (rule 101 — marketing unsubscribe copy is never applied to mandatory mail).
export function renderNotificationTemplate(
  notificationType: string,
  templateVersion: string,
  safeVariables: Record<string, unknown>,
): RenderedNotification {
  const definition = getNotificationTypeDefinition(notificationType);
  if (!definition) throw new NotificationTemplateError("UNKNOWN_NOTIFICATION_TYPE");
  if (definition.templateVersion !== templateVersion) throw new NotificationTemplateError("UNKNOWN_TEMPLATE_VERSION");
  const validationError = validateSafeVariables(definition, safeVariables);
  if (validationError) throw new NotificationTemplateError(validationError);
  const renderer = RENDERERS[`${notificationType}@${templateVersion}`];
  if (!renderer) throw new NotificationTemplateError("UNKNOWN_TEMPLATE_VERSION");
  const rendered = renderer(safeVariables);
  return {
    subject: rendered.subject,
    text: `${rendered.text}\n\n${FOOTER_TEXT}`,
    html: `${rendered.html}${FOOTER_HTML}`,
  };
}
