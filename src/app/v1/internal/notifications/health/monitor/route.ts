import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { monitorNotificationDeliveryHealth } from "@/lib/notifications/health-monitor";

// NT1-G08: scheduler-triggered health/alert sweep, same shape as AN-001's
// /v1/internal/analytics/daily-runs/monitor — connects queue-age/failure-
// rate/provider-health breaches to the platform's approved operational-
// alert mechanism (platform_alerts).
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-health-monitor");
  if (!guard.ok) return guard.response;
  return NextResponse.json(monitorNotificationDeliveryHealth(), { headers: { "Cache-Control": "no-store" } });
}
