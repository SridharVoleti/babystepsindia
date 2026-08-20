import { NextResponse } from "next/server";
import { listApps } from "@/lib/db/app-registry-repo";

// AC11/AC24/AT-AR-001-13: public/trusted read — active apps' safe
// metadata only (internal_notes is never present in this view, and
// draft/soft_deleted apps never appear here regardless of caller).
export async function GET() {
  const apps = await listApps({ status: "active" });
  return NextResponse.json({ apps });
}
