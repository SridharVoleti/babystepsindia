import { NextResponse } from "next/server";
import { requireInternalService, type PlatformServiceRole } from "@/lib/auth/internal-service-guard";
import { getNotificationIntentBySource } from "@/lib/notifications/service";

// NT1-G06: only a source domain's own read principal (or the one
// allowlisted cross-domain support principal) may read that domain's
// notification status — never a shared reader every source can use.
const SOURCE_DOMAIN_READ_ROLES: Record<string, PlatformServiceRole> = {
  billing: "notification-read-billing",
  identity: "notification-read-identity",
  operations: "notification-read-operations",
};

// API-NT-005: authorized source/support read of compact, delivery-aware
// status only — never business authority (rule 114).
export async function GET(request: Request,
  { params }: { params: { sourceDomain: string; sourceEventKey: string } }) {
  const sourceDomain = decodeURIComponent(params.sourceDomain);
  const domainRole = SOURCE_DOMAIN_READ_ROLES[sourceDomain];
  if (!domainRole) return NextResponse.json({ error: "UNKNOWN_SOURCE_DOMAIN" }, { status: 400 });

  const guard = await requireInternalService(request, [domainRole, "notification-read-support"]);
  if (!guard.ok) return guard.response;
  const notifications = await getNotificationIntentBySource(sourceDomain, decodeURIComponent(params.sourceEventKey));
  return NextResponse.json({ notifications }, { headers: { "Cache-Control": "no-store" } });
}
