import { NextResponse } from "next/server";
import { decideInternalAuthorization, InternalAuthorizationDecisionError, platformServiceSecret } from "@/lib/authorization/internal-decision";
import { AUTHORIZATION_ACTIONS, type AuthorizationAction } from "@/lib/authorization/modes";

const resourceFields = ["parentUserId", "learnerId", "appId", "learnerSessionId"];

export async function POST(request: Request) {
  const assertion = request.headers.get("x-babysteps-service-assertion") ?? "";
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => !["action", "resource"].includes(key))
      || typeof body.action !== "string" || !(body.action in AUTHORIZATION_ACTIONS)
      || !body.resource || typeof body.resource !== "object" || Array.isArray(body.resource)
      || Object.entries(body.resource as Record<string, unknown>).some(([key, value]) => !resourceFields.includes(key) || typeof value !== "string"))
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    const decision = await decideInternalAuthorization({ assertion, action: body.action as AuthorizationAction,
      resource: body.resource as Record<string, string>, now: new Date(), resolveSecret: platformServiceSecret });
    return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof InternalAuthorizationDecisionError ? error.code : "AUTHORIZATION_DENIED";
    const status = code === "SERVICE_AUTHENTICATION_FAILED" ? 401 : code === "SERVICE_ASSERTION_REPLAYED" ? 409 : 403;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
