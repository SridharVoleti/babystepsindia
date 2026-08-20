import { NextResponse } from "next/server";
import { getAppByKey } from "@/lib/db/app-registry-repo";

// AC14/AT-AR-001-15: unknown keys fail closed — 404, never an implicit
// create. Draft/soft-deleted apps are treated as not found for this
// public/trusted read (activeOnly).
export async function GET(_request: Request, { params }: { params: { appKey: string } }) {
  const app = await getAppByKey(params.appKey, { activeOnly: true });
  if (!app) {
    return NextResponse.json({ error: "APP_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json(app);
}
