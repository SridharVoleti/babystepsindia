import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { listParentSubscriptions } from "@/lib/billing/bi001-service";

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.billing.subscriptions.read");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`billing-subscriptions:${guard.parent.session.sub}`, 120, 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  const url = new URL(request.url);
  const rawLimit = Number(url.searchParams.get("limit") ?? 25);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  return NextResponse.json(listParentSubscriptions(guard.parent.session.sub, {
    status: url.searchParams.get("status") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: rawLimit,
  }), { headers: { "Cache-Control": "private, no-store" } });
}
