import { NextResponse } from "next/server";
import { hasRecentAdminAuthentication, requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAvailabilityError, appAvailabilityErrorStatus, readAdminAvailability } from
  "@/lib/app-availability/service";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app_availability.read");
  if (!guard.ok) return guard.response;
  if (!hasRecentAdminAuthentication(guard.session)) {
    return NextResponse.json({ error: "RECENT_REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  if (!checkRateLimit(`availability-read:${guard.session.sub}`, 120, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  const environment = new URL(request.url).searchParams.get("environment") ?? "production";
  try {
    return NextResponse.json(readAdminAvailability(params.appId, environment, new Date()),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AppAvailabilityError) {
      return NextResponse.json({ error: error.code }, { status: appAvailabilityErrorStatus(error.code),
        headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
