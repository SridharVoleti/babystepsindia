import { NextResponse } from "next/server";
import { requireApiParent } from "@/lib/auth/api-guard";
import { getSecurityView } from "@/lib/db/account-security-repo";

// AC1/AC7: only the authenticated parent's own current verified email and
// pending-email-change state — email always comes from the session, never
// from a query param or body.
export async function GET() {
  const guard = await requireApiParent();
  if (!guard.ok) return guard.response;

  const view = getSecurityView(guard.context.session.sub, guard.context.user.email);
  return NextResponse.json(view);
}
