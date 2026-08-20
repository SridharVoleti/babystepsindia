import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { bootstrapInitialApps } from "@/lib/app-registry/bootstrap";

// Idempotent — safe to call more than once (business rule 13). Registers
// Chess Master, Magical Math, and Speed Reader through the same
// createApp() service any other admin-created app goes through.
export async function POST() {
  const guard = await requireAdminApi("admin.app.bootstrap");
  if (!guard.ok) return guard.response;

  const apps = await bootstrapInitialApps(guard.session.sub);
  return NextResponse.json({ apps });
}
