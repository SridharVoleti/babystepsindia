import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { DbClient } from "@/lib/db-client/types";
import { verifyAppClientAssertion } from "@/lib/app-launch/principal";
import { createManagedServicePrincipal } from "@/lib/authorization/principals";

const TOKEN_AUDIENCE = "babysteps:platform-api";
const TOKEN_ISSUER = "https://babysteps.in";
// GAP-050: SC-001 eliminated recurring heartbeats — this scope now names the
// one non-periodic runtime-lifecycle use that remains (confirming usable
// launch, reporting disconnect/resume), not a polling heartbeat.
export const APP_API_SCOPES = [
  "session.usable_launch", "progress.read", "progress.write", "lesson.complete", "session.complete",
  "progress.summary.write", "progress.integrity_validate", "progress.recover", "session.exit", "achievement.write",
  "journey.milestone.write",
] as const;
export type AppApiScope = typeof APP_API_SCOPES[number];
// GAP-048/089: the grant a session starts with, before usable launch is
// confirmed, is scoped to this alone — it cannot read/write progress or
// complete a session.
const PROVISIONAL_APP_API_SCOPES: readonly AppApiScope[] = ["session.usable_launch"];

export class AppAuthorizationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AppAuthorizationError"; }
}

type GrantRow = {
  id: string; learner_session_id: string; learner_id: string; app_id: string; environment: string;
  deployment_id: string; release_id: string; app_principal_id: string; scopes_json: string;
  api_contract_version: string; grant_version: number; status: string; expires_at: string;
};

type AccessClaims = {
  iss: string; aud: string; jti: string; iat: number; exp: number; grant_id: string; grant_version: number;
  learner_session_id: string; learner_id: string; app_id: string; environment: string; deployment_id: string;
  release_id: string; app_principal_id: string; scopes: string[]; api_contract_version: string;
};

function encoded(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }

function signingConfig() {
  const privatePem = process.env.APP_ACCESS_SIGNING_PRIVATE_KEY?.replaceAll("\\n", "\n");
  const publicPem = process.env.APP_ACCESS_SIGNING_PUBLIC_KEY?.replaceAll("\\n", "\n");
  const kid = process.env.APP_ACCESS_SIGNING_KEY_ID;
  if (!privatePem || !publicPem || !kid) throw new Error("LA-002 signing keys are not configured");
  let configured: Record<string, string> = {};
  try { configured = JSON.parse(process.env.APP_ACCESS_VERIFY_KEYS || "{}"); }
  catch { throw new Error("APP_ACCESS_VERIFY_KEYS must be a JSON object"); }
  const verificationKeys = new Map(Object.entries({ ...configured, [kid]: publicPem })
    .map(([keyId, pem]) => [keyId, createPublicKey(pem.replaceAll("\\n", "\n"))]));
  return { privateKey: createPrivateKey(privatePem), verificationKeys, kid };
}

function issueAccessToken(grant: GrantRow, now: Date, tokenId: string = randomUUID()) {
  const { privateKey, kid } = signingConfig();
  const iat = Math.floor(now.getTime() / 1000);
  const exp = Math.min(iat + 300, Math.floor(new Date(grant.expires_at).getTime() / 1000));
  if (exp <= iat) throw new AppAuthorizationError("LEARNER_SESSION_NOT_ACTIVE");
  const claims: AccessClaims = { iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, jti: tokenId, iat, exp,
    grant_id: grant.id, grant_version: grant.grant_version, learner_session_id: grant.learner_session_id,
    learner_id: grant.learner_id, app_id: grant.app_id, environment: grant.environment,
    deployment_id: grant.deployment_id, release_id: grant.release_id,
    app_principal_id: grant.app_principal_id, scopes: JSON.parse(grant.scopes_json) as string[],
    api_contract_version: grant.api_contract_version };
  const header = encoded({ alg: "EdDSA", typ: "JWT", kid });
  const payload = encoded(claims);
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return { accessToken: `${header}.${payload}.${signature}`, accessTokenExpiresAt: new Date(exp * 1000).toISOString(), claims };
}

function verifyAccessToken(token: string, now: Date, allowExpired = false): AccessClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AppAuthorizationError("APP_ACCESS_TOKEN_INVALID");
  let header: { alg?: string; kid?: string }; let claims: AccessClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch { throw new AppAuthorizationError("APP_ACCESS_TOKEN_INVALID"); }
  const { verificationKeys } = signingConfig();
  const publicKey = header.kid ? verificationKeys.get(header.kid) : undefined;
  if (header.alg !== "EdDSA" || !publicKey ||
      !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url")) ||
      claims.iss !== TOKEN_ISSUER || claims.aud !== TOKEN_AUDIENCE ||
      (!allowExpired && claims.exp <= Math.floor(now.getTime() / 1000))) {
    throw new AppAuthorizationError("APP_ACCESS_TOKEN_INVALID");
  }
  return claims;
}

function grantRow(id: string) {
  return getDb().prepare("select * from app_session_grants where id=?").get(id) as GrantRow | undefined;
}

function assertLiveGrant(grant: GrantRow | undefined, claims: AccessClaims, principalId: string, now: Date) {
  if (!grant) throw new AppAuthorizationError("APP_AUTHORIZATION_NOT_FOUND");
  if (!["provisional","active"].includes(grant.status) || grant.grant_version !== claims.grant_version ||
      grant.app_principal_id !== principalId) throw new AppAuthorizationError(
        grant.app_principal_id !== principalId ? "APP_TOKEN_PRINCIPAL_MISMATCH" : "APP_GRANT_REVOKED");
  if (grant.expires_at <= now.toISOString()) throw new AppAuthorizationError("LEARNER_SESSION_NOT_ACTIVE");
  const bindings = ["learner_session_id","learner_id","app_id","environment","deployment_id","release_id","app_principal_id"] as const;
  if (bindings.some((key) => claims[key] !== grant[key])) throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const session = getDb().prepare("select status,parent_user_id from learner_sessions where id=?")
    .get(grant.learner_session_id) as { status: string; parent_user_id: string } | undefined;
  // SC-003: the grant must stay usable while the session is still
  // 'starting'/reserved — that's exactly when the app backend calls
  // confirmUsableLaunch using this same dual proof. Downstream domain
  // functions (sessionFor, disconnect/complete's own status checks) each
  // independently guard against progress/lifecycle calls before activation.
  if (!session || !["starting","active","disconnected","resumable"].includes(session.status))
    throw new AppAuthorizationError("LEARNER_SESSION_NOT_ACTIVE");
  // GAP-051: a provisional (usable-launch-only) grant is only meaningful
  // while the session itself is still starting/reserved — it never grants
  // progress/completion access even if somehow presented after activation.
  if (grant.status === "provisional" && session.status !== "starting") {
    throw new AppAuthorizationError("APP_GRANT_REVOKED");
  }
  const profile = getDb().prepare("select account_status from profiles where id=?").get(session.parent_user_id) as
    { account_status: string } | undefined;
  const app = getDb().prepare("select registry_status from app_registry where id=?").get(grant.app_id) as
    { registry_status: string } | undefined;
  const principal = getDb().prepare("select status from app_service_principals where id=?").get(principalId) as
    { status: string } | undefined;
  if (principal?.status !== "active") throw new AppAuthorizationError("APP_SERVICE_PRINCIPAL_REVOKED");
  if (profile?.account_status !== "active" || app?.registry_status !== "active")
    throw new AppAuthorizationError("APP_GRANT_REVOKED");
  return grant;
}

export function issueInitialAppGrant(input: { learnerSessionId: string; principalId: string; now: Date }) {
  const db = getDb();
  const existing = db.prepare("select * from app_session_grants where learner_session_id=?")
    .get(input.learnerSessionId) as GrantRow | undefined;
  if (existing) {
    if (existing.app_principal_id !== input.principalId) throw new AppAuthorizationError("APP_TOKEN_PRINCIPAL_MISMATCH");
    const issued = issueAccessToken(existing, input.now);
    return { grantId: existing.id, accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt, scopes: JSON.parse(existing.scopes_json),
      apiContractVersion: existing.api_contract_version };
  }
  const session = db.prepare("select * from learner_sessions where id=?").get(input.learnerSessionId) as
    Record<string, string> | undefined;
  const principal = db.prepare("select * from app_service_principals where id=?").get(input.principalId) as
    Record<string, string> | undefined;
  if (!session || !principal || session.app_id !== principal.app_id ||
      session.deployment_id !== principal.deployment_id || session.deployment_environment !== principal.environment)
    throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const deployment = db.prepare("select compatibility_status,status,api_contract_version from app_deployment_launch_controls where deployment_id=?")
    .get(session.deployment_id) as { compatibility_status: string; status: string; api_contract_version: string } | undefined;
  if (deployment?.compatibility_status !== "passed") throw new AppAuthorizationError("APP_API_CONTRACT_INCOMPATIBLE");
  if (deployment.status !== "published") throw new AppAuthorizationError("APP_DEPLOYMENT_WINDOW_BLOCKED");
  const timestamp = input.now.toISOString();
  // GAP-048/089: provisional at issuance — only session.usable_launch is
  // granted until confirmUsableLaunch activates it (see activateAppGrant).
  const grant: GrantRow = { id: randomUUID(), learner_session_id: session.id, learner_id: session.learner_id,
    app_id: session.app_id, environment: session.deployment_environment, deployment_id: session.deployment_id,
    release_id: session.release_id, app_principal_id: input.principalId,
    scopes_json: JSON.stringify(PROVISIONAL_APP_API_SCOPES), api_contract_version: deployment.api_contract_version,
    grant_version: 1, status: "provisional", expires_at: session.session_expires_at };
  const issued = issueAccessToken(grant, input.now);
  db.prepare(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,1,'provisional',?,?,?)`).run(grant.id,grant.learner_session_id,grant.learner_id,
      grant.app_id,grant.environment,grant.deployment_id,grant.release_id,grant.app_principal_id,grant.scopes_json,
      grant.api_contract_version,grant.expires_at,timestamp,timestamp);
  db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_issued',?)")
    .run(randomUUID(),session.parent_user_id,JSON.stringify({ grantId: grant.id, sessionId: session.id,
      appId: grant.app_id, deploymentId: grant.deployment_id, principalId: grant.app_principal_id }));
  return { grantId: grant.id, accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt,
    scopes: [...PROVISIONAL_APP_API_SCOPES], apiContractVersion: grant.api_contract_version };
}

// LA-001 production exchange path: uses the caller's DbClient transaction so
// launch-code consumption, provisional grant issuance, receipt persistence,
// and audit evidence commit or roll back as one Postgres unit. The legacy
// wrapper above remains temporarily for LA-002 callers until its own migration.
export async function issueInitialAppGrantWithClient(db: DbClient, input: {
  learnerSessionId: string; principalId: string; now: Date;
}) {
  const existing = await db.get<GrantRow>("select * from app_session_grants where learner_session_id=?", [input.learnerSessionId]);
  if (existing) {
    if (existing.app_principal_id !== input.principalId) throw new AppAuthorizationError("APP_TOKEN_PRINCIPAL_MISMATCH");
    const issued = issueAccessToken(existing, input.now);
    return { grantId: existing.id, accessToken: issued.accessToken,
      accessTokenExpiresAt: issued.accessTokenExpiresAt, scopes: JSON.parse(existing.scopes_json) as string[],
      apiContractVersion: existing.api_contract_version };
  }
  const session = await db.get<Record<string, string>>("select * from learner_sessions where id=?", [input.learnerSessionId]);
  const principal = await db.get<Record<string, string>>("select * from app_service_principals where id=?", [input.principalId]);
  if (!session || !principal || session.app_id !== principal.app_id ||
      session.deployment_id !== principal.deployment_id || session.deployment_environment !== principal.environment) {
    throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  }
  const deployment = await db.get<{ compatibility_status: string; status: string; api_contract_version: string }>(
    "select compatibility_status,status,api_contract_version from app_deployment_launch_controls where deployment_id=?",
    [session.deployment_id]);
  if (deployment?.compatibility_status !== "passed") throw new AppAuthorizationError("APP_API_CONTRACT_INCOMPATIBLE");
  if (deployment.status !== "published") throw new AppAuthorizationError("APP_DEPLOYMENT_WINDOW_BLOCKED");
  const timestamp = input.now.toISOString();
  const grant: GrantRow = { id: randomUUID(), learner_session_id: session.id, learner_id: session.learner_id,
    app_id: session.app_id, environment: session.deployment_environment, deployment_id: session.deployment_id,
    release_id: session.release_id, app_principal_id: input.principalId,
    scopes_json: JSON.stringify(PROVISIONAL_APP_API_SCOPES), api_contract_version: deployment.api_contract_version,
    grant_version: 1, status: "provisional", expires_at: session.session_expires_at };
  const issued = issueAccessToken(grant, input.now);
  await db.run(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,1,'provisional',?,?,?)`, [grant.id, grant.learner_session_id, grant.learner_id,
    grant.app_id, grant.environment, grant.deployment_id, grant.release_id, grant.app_principal_id, grant.scopes_json,
    grant.api_contract_version, grant.expires_at, timestamp, timestamp]);
  await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_issued',?)",
    [randomUUID(), session.parent_user_id, JSON.stringify({ grantId: grant.id, sessionId: session.id,
      appId: grant.app_id, deploymentId: grant.deployment_id, principalId: grant.app_principal_id })]);
  return { grantId: grant.id, accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt,
    scopes: [...PROVISIONAL_APP_API_SCOPES], apiContractVersion: grant.api_contract_version };
}

// GAP-048/089: called from confirmUsableLaunch, in the same transaction as
// the session's starting->active flip, once the app backend's browser
// runtime has actually initialized. Atomically upgrades the provisional
// grant to the full app-service scope set. Deliberately does not bump
// grant_version — authorizeAppRequest re-reads scopes_json live from the
// grant row on every call rather than trusting a snapshot baked into the
// token's claims, so the still-valid provisional-issuance token keeps
// working and simply gains the wider scope, with no reissue/renewal
// round-trip needed right at the moment usable launch is confirmed.
export function activateAppGrant(grantId: string, now: Date): boolean {
  const changed = getDb().prepare(
    `update app_session_grants set status='active',scopes_json=?,updated_at=?
     where id=? and status='provisional'`,
  ).run(JSON.stringify(APP_API_SCOPES), now.toISOString(), grantId).changes;
  return changed === 1;
}

export function authorizeAppRequest(input: { accessToken?: string; principalId?: string; requiredScope: AppApiScope; now: Date }) {
  if (!input.accessToken || !input.principalId) throw new AppAuthorizationError("APP_DUAL_CREDENTIAL_REQUIRED");
  const claims = verifyAccessToken(input.accessToken, input.now);
  const grant = assertLiveGrant(grantRow(claims.grant_id), claims, input.principalId, input.now);
  const scopes = JSON.parse(grant.scopes_json) as string[];
  if (!scopes.includes(input.requiredScope)) throw new AppAuthorizationError("APP_SCOPE_NOT_GRANTED");
  return { grantId: grant.id, learnerSessionId: grant.learner_session_id, learnerId: grant.learner_id,
    appId: grant.app_id, principalId: grant.app_principal_id, environment: grant.environment,
    deploymentId: grant.deployment_id, releaseId: grant.release_id, scopes,
    principal: createManagedServicePrincipal({ id: grant.app_principal_id, verified: true, serviceKind: "learning_app",
      appId: grant.app_id, learnerSessionId: grant.learner_session_id }) };
}

export async function authorizeDualCredentialRequest(input: { accessToken?: string; clientAssertion?: string;
  requiredScope: AppApiScope; now: Date }) {
  if (!input.accessToken || !input.clientAssertion) throw new AppAuthorizationError("APP_DUAL_CREDENTIAL_REQUIRED");
  const auth = verifyAppClientAssertion(input.clientAssertion, input.now, TOKEN_AUDIENCE);
  const db = getDb();
  const run = db.transaction(() => {
    try { db.prepare("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)")
      .run(auth.principal.id,auth.jti,auth.expiresAt); }
    catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
    return authorizeAppRequest({ accessToken: input.accessToken, principalId: auth.principal.id,
      requiredScope: input.requiredScope, now: input.now });
  });
  return run();
}

export function consumeAppAssertionReplay(auth: { principal: { id: string }; jti: string; expiresAt: string }) {
  try { getDb().prepare("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)")
    .run(auth.principal.id,auth.jti,auth.expiresAt); }
  catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
}

export function renewAppGrant(input: { grantId: string; accessToken: string; principalId: string;
  idempotencyKey: string; now: Date }) {
  const claims = verifyAccessToken(input.accessToken, input.now, true);
  if (claims.grant_id !== input.grantId) throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const grant = assertLiveGrant(grantRow(input.grantId), claims, input.principalId, input.now);
  const requestHash = hash(JSON.stringify({ grantId: input.grantId, tokenId: claims.jti }));
  const existing = getDb().prepare(`select request_hash,response_json from app_session_grant_requests
    where principal_id=? and grant_id=? and idempotency_key=?`).get(input.principalId,input.grantId,input.idempotencyKey) as
    { request_hash: string; response_json: string } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new AppAuthorizationError("IDEMPOTENCY_KEY_REUSED");
    const receipt = JSON.parse(existing.response_json) as { tokenId: string; issuedAt: string };
    const replayed = issueAccessToken(grant,new Date(receipt.issuedAt),receipt.tokenId);
    return renewalResponse(grant,replayed.accessToken,replayed.accessTokenExpiresAt);
  }
  const issued = issueAccessToken(grant, input.now);
  const response = renewalResponse(grant, issued.accessToken, issued.accessTokenExpiresAt);
  getDb().prepare(`insert into app_session_grant_requests(principal_id,grant_id,idempotency_key,request_hash,
    response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`).run(input.principalId,input.grantId,
      input.idempotencyKey,requestHash,JSON.stringify({ tokenId: issued.claims.jti, issuedAt: input.now.toISOString() }),
      issued.accessTokenExpiresAt,input.now.toISOString());
  const session = getDb().prepare("select parent_user_id from learner_sessions where id=?")
    .get(grant.learner_session_id) as { parent_user_id: string };
  getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_renewed',?)")
    .run(randomUUID(),session.parent_user_id,JSON.stringify({ grantId: grant.id, sessionId: grant.learner_session_id,
      appId: grant.app_id, principalId: grant.app_principal_id }));
  return response;
}

export async function renewAppGrantWithAssertion(input: { grantId: string; accessToken: string;
  clientAssertion: string; idempotencyKey: string; now: Date }) {
  const auth = verifyAppClientAssertion(input.clientAssertion,input.now,
    "babysteps:app-session-grants:renew");
  const db = getDb();
  const run = db.transaction(() => {
    try { db.prepare("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)")
      .run(auth.principal.id,auth.jti,auth.expiresAt); }
    catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
    return renewAppGrant({ grantId: input.grantId,accessToken: input.accessToken,
      principalId: auth.principal.id,idempotencyKey: input.idempotencyKey,now: input.now });
  });
  return run();
}

function renewalResponse(grant: GrantRow, accessToken: string, accessTokenExpiresAt: string) {
  return { grantId: grant.id, accessToken, accessTokenExpiresAt,
    scopes: JSON.parse(grant.scopes_json) as string[], apiContractVersion: grant.api_contract_version };
}

export function revokeAppGrant(grantId: string, reason: string, now: Date) {
  const db = getDb();
  return db.transaction(() => {
    const grant = grantRow(grantId);
    if (!grant || !["provisional","active"].includes(grant.status)) return false;
    const changed = db.prepare(`update app_session_grants set status='revoked',grant_version=grant_version+1,
      revocation_reason=?,revoked_at=?,updated_at=? where id=? and status in ('provisional','active')`)
      .run(reason,now.toISOString(),now.toISOString(),grantId).changes === 1;
    if (changed) {
      const session = db.prepare("select parent_user_id from learner_sessions where id=?")
        .get(grant.learner_session_id) as { parent_user_id: string };
      db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_revoked',?)")
        .run(randomUUID(),session.parent_user_id,JSON.stringify({ grantId, sessionId: grant.learner_session_id,
          appId: grant.app_id, principalId: grant.app_principal_id, reason }));
    }
    return changed;
  })();
}

export function activeGrantCountForDeployment(appId: string, deploymentId: string) {
  return (getDb().prepare(`select count(*) n from app_session_grants where app_id=? and deployment_id=? and status='active'`)
    .get(appId,deploymentId) as { n: number }).n;
}

export function getAppGrantStatus(grantId: string, principalId: string) {
  const grant = grantRow(grantId);
  if (!grant || grant.app_principal_id !== principalId) throw new AppAuthorizationError("APP_AUTHORIZATION_NOT_FOUND");
  const session = getDb().prepare("select status from learner_sessions where id=?").get(grant.learner_session_id) as
    { status: string } | undefined;
  return { grantId: grant.id, status: grant.status, grantVersion: grant.grant_version,
    expiresAt: grant.expires_at, learnerSessionStatus: session?.status ?? "unavailable",
    scopes: JSON.parse(grant.scopes_json) as string[], apiContractVersion: grant.api_contract_version };
}

export function purgeExpiredAppGrants(now: Date) {
  const timestamp = now.toISOString();
  const db = getDb();
  const run = db.transaction(() => {
    const requests = db.prepare("delete from app_session_grant_requests where expires_at<=?").run(timestamp).changes;
    const grants = db.prepare(`delete from app_session_grants where expires_at<=? or learner_session_id in
      (select id from learner_sessions where status not in ('starting','active','disconnected','resumable'))`).run(timestamp).changes;
    return requests + grants;
  });
  return run();
}
