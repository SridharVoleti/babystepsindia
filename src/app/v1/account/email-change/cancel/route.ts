import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { cancelAuthoritativeEmailChange } from "@/lib/account/supabase-account-security";

// Postgres service transactions replace the legacy withLockedEndUserMutation SQLite boundary.

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.account.email_change.cancel");
  if (!guard.ok) return guard.response;

  const cancelled = await cancelAuthoritativeEmailChange(guard.parent.session.sub);
  if (!cancelled) {
    return NextResponse.json({ error: "NO_PENDING_REQUEST" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
