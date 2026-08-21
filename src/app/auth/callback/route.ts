import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { finalizeAuthoritativeEmailChange } from "@/lib/account/supabase-account-security";

// Handles the redirect from Supabase's email links (signup confirmation,
// password reset) — exchanges the one-time code for a session cookie.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/account";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.email) await finalizeAuthoritativeEmailChange(user.id, user.email);
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/auth-code-error`);
}
