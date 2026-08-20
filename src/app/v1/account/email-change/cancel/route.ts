import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { cancelEmailChange } from "@/lib/db/account-security-repo";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.email_change.cancel");
  if (!guard.ok) return guard.response;

  const cancelled = await withLockedEndUserMutation({ preflight: guard.authorization,
    action: "parent.account.email_change.cancel", resource: { parentUserId: guard.parent.session.sub },
    mutate: () => cancelEmailChange(guard.parent.session.sub) });
  if (!cancelled) {
    return NextResponse.json({ error: "NO_PENDING_REQUEST" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
