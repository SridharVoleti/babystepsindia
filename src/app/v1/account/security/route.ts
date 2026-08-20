import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { getSecurityView } from "@/lib/db/account-security-repo";

// AC1/AC7: only the authenticated parent's own current verified email and
// pending-email-change state — email always comes from the session, never
// from a query param or body.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.security.read");
  if (!guard.ok) return guard.response;

  const view = await getSecurityView(guard.parent.session.sub, guard.parent.user.email);
  return NextResponse.json(view);
}
