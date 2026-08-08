import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { monitorDailyAnalytics } from "@/lib/analytics/run-monitor";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "scheduler");
  if (!guard.ok) return guard.response;
  return NextResponse.json(monitorDailyAnalytics());
}
