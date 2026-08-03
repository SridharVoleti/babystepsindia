import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase session on every request and keeps the auth
// cookie current. Per REQ-08 §4.3, product-app middleware reads this same
// cookie on the shared `.babysteps.in` domain — this is the issuing side.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Env vars are stubbed until the Supabase project is provisioned (see
  // .env.local.example) — skip session refresh rather than 500 on every
  // route in the meantime.
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Required: touching getUser() is what actually refreshes the token.
  await supabase.auth.getUser();

  return response;
}
