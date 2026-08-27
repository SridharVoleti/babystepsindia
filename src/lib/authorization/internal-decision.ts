import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { resolveDbClient } from "@/lib/db-client";
import { getActiveAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import { authorizePrincipalAction, createManagedServicePrincipal } from "@/lib/authorization/principals";
import { AUTHORIZATION_ACTIONS, type AuthorizationAction } from "@/lib/authorization/modes";

export const INTERNAL_DECISION_AUDIENCE = "babysteps:internal:authorization-decision";
type PlatformPrincipal = { id: string; service_key: string; key_ref: string; public_key: string;
  status: string; valid_from: string; valid_until: string };

export class InternalAuthorizationDecisionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "InternalAuthorizationDecisionError"; }
}
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function pem(value: string | undefined) {
  if (!value) throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  return value.replaceAll("\\n", "\n");
}

// AU-004: platform-internal services (scheduler, ci-deployer, entitlement
// applier/evaluator, ...) prove identity with an Ed25519 signature — the
// platform verifies against the principal's stored public key, never a
// shared secret.
export function createPlatformServiceAssertion(input: { serviceKey: string; audience: string; jti: string;
  now: Date; privateKeyPem: string }) {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const header = encode({ alg: "EdDSA", typ: "JWT" });
  const payload = encode({ iss: input.serviceKey, sub: input.serviceKey, aud: input.audience, jti: input.jti,
    iat: issuedAt, exp: issuedAt + 60 });
  const unsigned = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(unsigned), createPrivateKey(pem(input.privateKeyPem))).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function authenticatePlatformServiceAssertion(input: { assertion: string; audience: string; now: Date }) {
  const { assertion, now } = input;
  let issuer: string | undefined;
  try { issuer = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()).iss; }
  catch { throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED"); }
  const principal = issuer
    ? await resolveDbClient().get<PlatformPrincipal>("select * from platform_service_principals where service_key=?", [issuer])
    : undefined;
  if (!principal || principal.status !== "active" || !principal.public_key ||
      now < new Date(principal.valid_from) || now >= new Date(principal.valid_until))
    throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  const parts = assertion.split(".");
  let signatureValid = false;
  try {
    const publicKey = createPublicKey(pem(principal.public_key));
    signatureValid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2] ?? "", "base64url"));
  } catch { signatureValid = false; }
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (header.alg !== "EdDSA" || header.typ !== "JWT" || !signatureValid
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
  now: Date }) {
  if (!input.assertion) throw new InternalAuthorizationDecisionError("SERVICE_AUTHENTICATION_FAILED");
  const authenticated = await authenticatePlatformServiceAssertion({ assertion: input.assertion,
    audience: INTERNAL_DECISION_AUDIENCE, now: input.now });
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
