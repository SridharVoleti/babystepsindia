import { getDb } from "@/lib/db/client";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { authorizePersonalDataUse } from "@/lib/privacy-governance/policy";

/**
 * PC-001: resolve a transactional notification recipient only at the delivery
 * boundary. The queue keeps the subscription reference, never a duplicate raw
 * email address.
 */
export function resolveBillingNotificationRecipient(subscriptionId: string) {
  authorizePersonalDataUse({
    key: "parent.email",
    purpose: "transactional_billing_notification",
    consumer: "billing_notification_service",
    surface: "server",
  });

  const row = getDb().prepare(
    `select u.email
     from subscriptions s
     join users u on u.id=s.purchaser_parent_id
     where s.id=?`,
  ).get(subscriptionId) as { email: string } | undefined;

  if (!row?.email) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row.email;
}
