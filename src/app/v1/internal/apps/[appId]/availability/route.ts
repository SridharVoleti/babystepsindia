import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { AppAvailabilityError, appAvailabilityErrorStatus, readAppAvailability } from
  "@/lib/app-availability/service";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireInternalService(request, "app-availability-reader");
  if (!guard.ok) return guard.response;
  const environment = new URL(request.url).searchParams.get("environment") ?? "production";
  try {
    return NextResponse.json(await readAppAvailability(params.appId, environment, new Date()),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AppAvailabilityError) {
      return NextResponse.json({ error: error.code }, { status: appAvailabilityErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
