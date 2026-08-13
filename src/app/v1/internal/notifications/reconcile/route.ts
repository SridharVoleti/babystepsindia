import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileNotificationDeliveries } from "@/lib/notifications/service";

// API-NT-004: resolves deliveries stuck "sending" (uncertain provider
// acceptance) before any further send is attempted (rule 68).
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-reconcile");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* body is optional */ }
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const staleAfterMinutes = typeof body.staleAfterMinutes === "number" ? body.staleAfterMinutes : undefined;
  const result = reconcileNotificationDeliveries({ limit, staleAfterMinutes });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
