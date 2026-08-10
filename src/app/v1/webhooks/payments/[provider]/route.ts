import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { processSignedProviderWebhook } from "@/lib/billing/bi002-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

// Provider signature over the untouched body is the only authority here.
// Parent cookies, browser redirects and learning-app grants are ignored.
export async function POST(request: Request, { params }: { params: { provider: string } }) {
  const signature = request.headers.get("x-billing-signature") ?? "";
  const environment = request.headers.get("x-billing-environment") ?? "";
  const accountId = request.headers.get("x-billing-account-id") ?? "";
  if (!checkRateLimit(`payment-webhook:${params.provider}:${accountId}`, 600, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  const rawBody = await request.text();
  try {
    const result = processSignedProviderWebhook(params.provider,
      { rawBody, signature, environment, accountId });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, {
        status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "no-store" },
      });
    }
    throw error;
  }
}
