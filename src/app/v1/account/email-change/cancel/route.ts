import { NextResponse } from "next/server";
import { requireApiParent } from "@/lib/auth/api-guard";
import { cancelEmailChange } from "@/lib/db/account-security-repo";

export async function POST() {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  const cancelled = cancelEmailChange(guard.context.session.sub);
  if (!cancelled) {
    return NextResponse.json({ error: "NO_PENDING_REQUEST" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
