import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { getNotificationIntentBySource } from "@/lib/notifications/service";

// API-NT-005: authorized source/support read of compact delivery status
// only — never business authority (rule 114).
export async function GET(request: Request,
  { params }: { params: { sourceDomain: string; sourceEventKey: string } }) {
  const guard = await requireInternalService(request, "notification-read");
  if (!guard.ok) return guard.response;
  const notifications = getNotificationIntentBySource(
    decodeURIComponent(params.sourceDomain), decodeURIComponent(params.sourceEventKey));
  return NextResponse.json({ notifications }, { headers: { "Cache-Control": "no-store" } });
}
