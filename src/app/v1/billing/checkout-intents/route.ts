import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { createCheckoutIntent } from "@/lib/billing/bi001-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";
import {
  PlatformPrivacyConsentError,
  capturePlatformPrivacyConsentAtSubscription,
} from "@/lib/privacy-governance/platform-consent";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const learnerId = typeof body.learnerId === "string" ? body.learnerId : "";
  const guard = await requireEndUserAuthorization(request, "parent.billing.checkout.create", { learnerId });
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`billing-checkout:${guard.parent.session.sub}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  if (!learnerId || typeof body.productId !== "string" || typeof body.productVersion !== "number" ||
    typeof body.priceId !== "string" || typeof body.priceVersion !== "number" ||
    typeof body.autoRenewEnabled !== "boolean" || typeof body.consentDisclosureVersion !== "string" ||
    typeof body.idempotencyKey !== "string" ||
    (body.privacyConsentAccepted !== undefined && typeof body.privacyConsentAccepted !== "boolean")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.billing.checkout.create", resource: { learnerId },
      mutate: () => {
        capturePlatformPrivacyConsentAtSubscription(
          guard.parent.session.sub,
          body.privacyConsentAccepted === true,
        );
        return createCheckoutIntent(guard.parent.session.sub, { learnerId,
          productId: body.productId as string, productVersion: body.productVersion as number,
          priceId: body.priceId as string, priceVersion: body.priceVersion as number,
          autoRenewEnabled: body.autoRenewEnabled as boolean,
          consentDisclosureVersion: body.consentDisclosureVersion as string,
          idempotencyKey: body.idempotencyKey as string });
      } });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformPrivacyConsentError) {
      return NextResponse.json({ error: error.code }, { status: 428, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
