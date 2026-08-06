import { NextResponse } from "next/server";
import { appServiceSecret } from "@/lib/app-launch/contracts";
import { verifyAppClientAssertion } from "@/lib/app-launch/principal";
import { AppLaunchError } from "@/lib/app-launch/errors";
import { AppAuthorizationError, consumeAppAssertionReplay, getAppGrantStatus } from "@/lib/app-authorization/service";

export async function GET(request: Request, { params }: { params: { grantId: string } }) {
  const assertion = request.headers.get("x-babysteps-app-assertion");
  if (!assertion) return NextResponse.json({ error: "APP_SERVICE_AUTHENTICATION_FAILED" }, { status: 401 });
  try {
    const auth = await verifyAppClientAssertion(assertion,new Date(),appServiceSecret,
      "babysteps:app-session-grants:status");
    consumeAppAssertionReplay(auth);
    return NextResponse.json(getAppGrantStatus(params.grantId,auth.principal.id),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const authenticationFailed = error instanceof AppLaunchError;
    const code = authenticationFailed ? error.code :
      error instanceof AppAuthorizationError ? error.code : "APP_AUTHORIZATION_NOT_FOUND";
    const status = authenticationFailed ? 401 : code === "APP_CLIENT_ASSERTION_REPLAYED" ? 409 : 404;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
