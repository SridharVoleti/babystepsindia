import { createHmac, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getActiveAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import { authorizePrincipalAction, createManagedServicePrincipal } from "@/lib/authorization/principals";
import { AUTHORIZATION_ACTIONS, type AuthorizationAction } from "@/lib/authorization/modes";

export const INTERNAL_DECISION_AUDIENCE = "babysteps:internal:authorization-decision";
type PlatformPrincipal = { id: string; service_key: string; key_ref: string; status: string; valid_from: string; valid_until: string };

export class InternalAuthorizationDecisionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "InternalAuthorizationDecisionError"; }
}
function secretValue(secret: string | undefined) {
  if (!secret || secret.length < 32) throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  return secret;
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function signature(value: string, secret: string) { return createHmac("sha256", secret).update(value).digest("base64url"); }

export async function createPlatformServiceAssertion(input: { serviceKey: string; audience: string; jti: string; now: Date; secret: string }) {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ iss: input.serviceKey, sub: input.serviceKey, aud: input.audience, jti: input.jti,
    iat: issuedAt, exp: issuedAt + 60 });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned, secretValue(input.secret))}`;
}

export async function authenticatePlatformServiceAssertion(input: { assertion: string; audience: string; now: Date;
  resolveSecret: (keyRef: string) => string | undefined }) {
  const { assertion, now, resolveSecret } = input;
  let issuer: string | undefined;
  try { issuer = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()).iss; }
  catch { throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED"); }
  const principal = issuer ? getDb().prepare("select * from platform_service_principals where service_key=?").get(issuer) as PlatformPrincipal | undefined : undefined;
  if (!principal || principal.status !== "active" || now < new Date(principal.valid_from) || now >= new Date(principal.valid_until))
    throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  try {
    const parts = assertion.split("."); const unsigned = `${parts[0]}.${parts[1]}`;
    const supplied = Buffer.from(parts[2] ?? "", "base64url");
    const expected = Buffer.from(signature(unsigned, secretValue(resolveSecret(principal.key_ref))), "base64url");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (header.alg !== "HS256" || header.typ !== "JWT" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
      || claims.iss !== principal.service_key || claims.sub !== principal.service_key || claims.aud !== input.audience
      || !claims.jti || !claims.iat || Number(claims.iat) > nowSeconds || Number(claims.exp) <= nowSeconds
      || Number(claims.exp) - Number(claims.iat) > 60)
      throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
    return { principal, jti: String(claims.jti), expiresAt: new Date(Number(claims.exp) * 1000).toISOString() };
  } catch (error) {
    if (error instanceof InternalAuthorizationDecisionError) throw error;
    throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  }
}

export async function decideInternalAuthorization(input: { assertion: string; action: AuthorizationAction;
  resource: { parentUserId?: string; learnerId?: string; appId?: string; learnerSessionId?: string };
  now: Date; resolveSecret: (keyRef: string) => string | undefined }) {
  if (!input.assertion) throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  const authenticated = await authenticatePlatformServiceAssertion({ assertion: input.assertion,
    audience: INTERNAL_DECISION_AUDIENCE, now: input.now, resolveSecret: input.resolveSecret });
  const db = getDb();
  return db.transaction(() => {
    try { db.prepare("insert into platform_service_assertion_replays(principal_id,jti,expires_at) values(?,?,?)")
      .run(authenticated.principal.id, authenticated.jti, authenticated.expiresAt); }
    catch { throw new InternalAuthorizationDecisionError("SERVICE_ASSERTION_REPLAYED"); }
    const principal = createManagedServicePrincipal({ id: authenticated.principal.id, verified: true, serviceKind: "platform" });
    const bundle = getActiveAuthorizationPolicyBundle();
    const allowed = (action: AuthorizationAction) => bundle.rules.some((rule) => rule.actionKey === action
      && rule.principalType === "managed_service" && rule.effect === "allow");
    if (!allowed("service.authorization.decide") || !allowed(input.action) || !(input.action in AUTHORIZATION_ACTIONS))
      throw new InternalAuthorizationDecisionError("AUTHORIZATION_DENIED");
    try { authorizePrincipalAction(principal, "service.authorization.decide");
      authorizePrincipalAction(principal, input.action, input.resource); }
    catch { throw new InternalAuthorizationDecisionError("AUTHORIZATION_DENIED"); }
    return { allowed: true as const, action: input.action, principalType: principal.type,
      policyVersion: bundle.version, policyDigest: bundle.digest, decidedAt: input.now.toISOString() };
  }).immediate();
}

export function platformServiceSecret(keyRef: string) {
  try { const values = JSON.parse(process.env.PLATFORM_SERVICE_SECRETS ?? "{}") as Record<string, string>; return values[keyRef]; }
  catch { return undefined; }
}
