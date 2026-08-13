import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runNotificationDeliverySweep } from "@/lib/notifications/service";

// API-NT-002: bounded-batch delivery worker. No dependency on browser
// sessions/heartbeats (rule 111) — a scheduler principal calls this on a
// recurring interval.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-delivery");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* body is optional */ }
  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const result = runNotificationDeliverySweep({ limit });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
