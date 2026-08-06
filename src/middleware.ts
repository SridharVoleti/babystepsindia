import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";
import { PUBLIC_API_ROUTE, resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";

const PROTECTED_PREFIXES = ["/account", "/admin"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/v1/")) {
    const declaration = resolveApiRouteAuthorization(request.method, pathname);
    if (!declaration) {
      return NextResponse.json({ error: "AUTHORIZATION_ACTION_UNKNOWN" }, { status: 404 });
    }
    if (declaration === PUBLIC_API_ROUTE) return NextResponse.next();
    const headers = new Headers(request.headers);
    // Overwrite rather than trust a caller-supplied authority/action header.
    headers.set("x-babysteps-canonical-action", declaration);
    return NextResponse.next({ request: { headers } });
  }
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));

  if (!isProtected) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (pathname.startsWith("/admin") && !session.isAdmin) {
    return NextResponse.redirect(new URL("/account", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/account/:path*", "/admin/:path*", "/v1/:path*"],
};
