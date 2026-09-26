import { NextResponse } from "next/server";
import { authenticateForMobile } from "@/lib/auth/mobile-auth";

// Mobile counterpart to the web's signInAction ((auth)/actions.ts): same
// rate limit and same deliberately-generic failure message, but returns a
// bearer token in the body instead of a Set-Cookie header — see
// authenticateForMobile's own comment for why.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const result = await authenticateForMobile(email, password);
  if (!result.ok) {
    const status = result.error === "RATE_LIMITED" ? 429 : 401;
    return NextResponse.json({ error: result.error }, { status, headers: { "Cache-Control": "no-store" } });
  }

  return NextResponse.json(
    {
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresIn: result.expiresIn,
      parentId: result.parentId,
      email: result.email,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
