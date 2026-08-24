import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { verifyAppClientAssertionWithClient } from "@/lib/app-launch/principal";
import { createManagedServicePrincipal } from "@/lib/authorization/principals";

const TOKEN_AUDIENCE = "babysteps:platform-api";
const TOKEN_ISSUER = "https://babysteps.in";
export const SUPPORTED_APP_API_CONTRACT_VERSIONS = ["1.0"] as const;
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

async function grantRow(db: DbClient, id: string) {
  return db.get<GrantRow>("select * from app_session_grants where id=?", [id]);
}

async function assertLiveGrant(db: DbClient, grant: GrantRow | undefined, claims: AccessClaims, principalId: string, now: Date) {
  if (!grant) throw new AppAuthorizationError("APP_AUTHORIZATION_NOT_FOUND");
  if (!["provisional","active"].includes(grant.status) || grant.grant_version !== claims.grant_version ||
      grant.app_principal_id !== principalId) throw new AppAuthorizationError(
        grant.app_principal_id !== principalId ? "APP_TOKEN_PRINCIPAL_MISMATCH" : "APP_GRANT_REVOKED");
  if (grant.expires_at <= now.toISOString()) throw new AppAuthorizationError("LEARNER_SESSION_NOT_ACTIVE");
  if (claims.api_contract_version !== grant.api_contract_version
    || !SUPPORTED_APP_API_CONTRACT_VERSIONS.includes(grant.api_contract_version as "1.0")) {
    throw new AppAuthorizationError("APP_API_CONTRACT_INCOMPATIBLE");
  }
  const bindings = ["learner_session_id","learner_id","app_id","environment","deployment_id","release_id","app_principal_id"] as const;
  if (bindings.some((key) => claims[key] !== grant[key])) throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const session = await db.get<{ status: string; parent_user_id: string }>(
    "select status,parent_user_id from learner_sessions where id=?", [grant.learner_session_id]);
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
  const profile = await db.get<{ account_status: string }>("select account_status from profiles where id=?",
    [session.parent_user_id]);
  const app = await db.get<{ registry_status: string }>("select registry_status from app_registry where id=?",
    [grant.app_id]);
  const principal = await db.get<{ status: string }>("select status from app_service_principals where id=?",
    [principalId]);
  if (principal?.status !== "active") throw new AppAuthorizationError("APP_SERVICE_PRINCIPAL_REVOKED");
  if (profile?.account_status !== "active" || app?.registry_status !== "active")
    throw new AppAuthorizationError("APP_GRANT_REVOKED");
  return grant;
}

// Used by LA-001 so grant issuance participates in the caller's code-consume
// transaction instead of opening a second connection.
export async function issueInitialAppGrantWithClient(db: DbClient, input: {
  learnerSessionId: string; principalId: string; now: Date;
}) {
  const existing = await db.get<GrantRow>("select * from app_session_grants where learner_session_id=?", [input.learnerSessionId]);
  if (existing) {
    if (existing.app_principal_id !== input.principalId) throw new AppAuthorizationError("APP_TOKEN_PRINCIPAL_MISMATCH");
    const issued = issueAccessToken(existing, input.now);
    return { grantId: existing.id, accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt,
      scopes: JSON.parse(existing.scopes_json) as string[], apiContractVersion: existing.api_contract_version };
  }
  const session = await db.get<Record<string, string>>("select * from learner_sessions where id=?", [input.learnerSessionId]);
  const principal = await db.get<Record<string, string>>("select * from app_service_principals where id=?", [input.principalId]);
  if (!session || !principal || session.app_id !== principal.app_id || session.deployment_id !== principal.deployment_id ||
      session.deployment_environment !== principal.environment) throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const deployment = await db.get<{ compatibility_status: string; status: string; api_contract_version: string }>(
    "select compatibility_status,status,api_contract_version from app_deployment_launch_controls where deployment_id=?",
    [session.deployment_id]);
  if (deployment?.compatibility_status !== "passed"
    || !SUPPORTED_APP_API_CONTRACT_VERSIONS.includes(deployment.api_contract_version as "1.0")) {
    throw new AppAuthorizationError("APP_API_CONTRACT_INCOMPATIBLE");
  }
  if (deployment.status !== "published") throw new AppAuthorizationError("APP_DEPLOYMENT_WINDOW_BLOCKED");
  const timestamp = input.now.toISOString();
  const grant: GrantRow = { id: randomUUID(), learner_session_id: session.id, learner_id: session.learner_id,
    app_id: session.app_id, environment: session.deployment_environment, deployment_id: session.deployment_id,
    release_id: session.release_id, app_principal_id: input.principalId,
    scopes_json: JSON.stringify(PROVISIONAL_APP_API_SCOPES), api_contract_version: deployment.api_contract_version,
    grant_version: 1, status: "provisional", expires_at: session.session_expires_at };
  const issued = issueAccessToken(grant, input.now);
  const inserted = await db.run(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,1,'provisional',?,?,?) on conflict(learner_session_id) do nothing`,
    [grant.id, grant.learner_session_id, grant.learner_id,
    grant.app_id, grant.environment, grant.deployment_id, grant.release_id, grant.app_principal_id, grant.scopes_json,
    grant.api_contract_version, grant.expires_at, timestamp, timestamp]);
  if (inserted.changes === 0) {
    const winner = await db.get<GrantRow>("select * from app_session_grants where learner_session_id=?", [input.learnerSessionId]);
    if (!winner || winner.app_principal_id !== input.principalId) throw new AppAuthorizationError("APP_TOKEN_PRINCIPAL_MISMATCH");
    const winnerToken = issueAccessToken(winner, input.now);
    return { grantId: winner.id, accessToken: winnerToken.accessToken,
      accessTokenExpiresAt: winnerToken.accessTokenExpiresAt, scopes: JSON.parse(winner.scopes_json) as string[],
      apiContractVersion: winner.api_contract_version };
  }
  await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_issued',?)",
    [randomUUID(), session.parent_user_id, JSON.stringify({ grantId: grant.id, sessionId: session.id,
      appId: grant.app_id, deploymentId: grant.deployment_id, principalId: grant.app_principal_id })]);
  return { grantId: grant.id, accessToken: issued.accessToken, accessTokenExpiresAt: issued.accessTokenExpiresAt,
    scopes: [...PROVISIONAL_APP_API_SCOPES], apiContractVersion: grant.api_contract_version };
}

export async function issueInitialAppGrant(input: { learnerSessionId: string; principalId: string; now: Date }) {
  return resolveDbClient().transaction((db) => issueInitialAppGrantWithClient(db, input));
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
export async function activateAppGrant(grantId: string, now: Date): Promise<boolean> {
  const changed = (await resolveDbClient().run(
    `update app_session_grants set status='active',scopes_json=?,updated_at=?
     where id=? and status='provisional'`,
    [JSON.stringify(APP_API_SCOPES), now.toISOString(), grantId])).changes;
  return changed === 1;
}

export async function authorizeAppRequest(input: { accessToken?: string; principalId?: string; requiredScope: AppApiScope; now: Date },
  db: DbClient = resolveDbClient()) {
  if (!input.accessToken || !input.principalId) throw new AppAuthorizationError("APP_DUAL_CREDENTIAL_REQUIRED");
  const claims = verifyAccessToken(input.accessToken, input.now);
  const grant = await assertLiveGrant(db, await grantRow(db, claims.grant_id), claims, input.principalId, input.now);
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
  const client = resolveDbClient();
  const auth = await verifyAppClientAssertionWithClient(client, input.clientAssertion, input.now, TOKEN_AUDIENCE);
  return client.transaction(async (db) => {
    try { await db.run("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)",
      [auth.principal.id,auth.jti,auth.expiresAt]); }
    catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
    return authorizeAppRequest({ accessToken: input.accessToken, principalId: auth.principal.id,
      requiredScope: input.requiredScope, now: input.now }, db);
  });
}

export async function consumeAppAssertionReplay(auth: { principal: { id: string }; jti: string; expiresAt: string }) {
  try { await resolveDbClient().run("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)",
    [auth.principal.id,auth.jti,auth.expiresAt]); }
  catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
}

export async function renewAppGrant(input: { grantId: string; accessToken: string; principalId: string;
  idempotencyKey: string; now: Date }, db: DbClient = resolveDbClient()) {
  const claims = verifyAccessToken(input.accessToken, input.now, true);
  if (claims.grant_id !== input.grantId) throw new AppAuthorizationError("APP_TOKEN_BINDING_MISMATCH");
  const grant = await assertLiveGrant(db, await grantRow(db, input.grantId), claims, input.principalId, input.now);
  const requestHash = hash(JSON.stringify({ grantId: input.grantId, tokenId: claims.jti }));
  const existing = await db.get<{ request_hash: string; response_json: string }>(
    `select request_hash,response_json from app_session_grant_requests
    where principal_id=? and grant_id=? and idempotency_key=?`, [input.principalId,input.grantId,input.idempotencyKey]);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new AppAuthorizationError("IDEMPOTENCY_KEY_REUSED");
    const receipt = JSON.parse(existing.response_json) as { tokenId: string; issuedAt: string };
    const replayed = issueAccessToken(grant,new Date(receipt.issuedAt),receipt.tokenId);
    return renewalResponse(grant,replayed.accessToken,replayed.accessTokenExpiresAt);
  }
  const issued = issueAccessToken(grant, input.now);
  const response = renewalResponse(grant, issued.accessToken, issued.accessTokenExpiresAt);
  await db.run(`insert into app_session_grant_requests(principal_id,grant_id,idempotency_key,request_hash,
    response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`,
    [input.principalId,input.grantId,
      input.idempotencyKey,requestHash,JSON.stringify({ tokenId: issued.claims.jti, issuedAt: input.now.toISOString() }),
      issued.accessTokenExpiresAt,input.now.toISOString()]);
  const session = (await db.get<{ parent_user_id: string }>("select parent_user_id from learner_sessions where id=?",
    [grant.learner_session_id]))!;
  await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_renewed',?)",
    [randomUUID(),session.parent_user_id,JSON.stringify({ grantId: grant.id, sessionId: grant.learner_session_id,
      appId: grant.app_id, principalId: grant.app_principal_id })]);
  return response;
}

export async function renewAppGrantWithAssertion(input: { grantId: string; accessToken: string;
  clientAssertion: string; idempotencyKey: string; now: Date }) {
  const client = resolveDbClient();
  const auth = await verifyAppClientAssertionWithClient(client, input.clientAssertion,input.now,
    "babysteps:app-session-grants:renew");
  return client.transaction(async (db) => {
    try { await db.run("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)",
      [auth.principal.id,auth.jti,auth.expiresAt]); }
    catch { throw new AppAuthorizationError("APP_CLIENT_ASSERTION_REPLAYED"); }
    return renewAppGrant({ grantId: input.grantId,accessToken: input.accessToken,
      principalId: auth.principal.id,idempotencyKey: input.idempotencyKey,now: input.now }, db);
  });
}

function renewalResponse(grant: GrantRow, accessToken: string, accessTokenExpiresAt: string) {
  return { grantId: grant.id, accessToken, accessTokenExpiresAt,
    scopes: JSON.parse(grant.scopes_json) as string[], apiContractVersion: grant.api_contract_version };
}

export async function revokeAppGrant(grantId: string, reason: string, now: Date) {
  return resolveDbClient().transaction(async (db) => {
    const grant = await grantRow(db, grantId);
    if (!grant || !["provisional","active"].includes(grant.status)) return false;
    const changed = (await db.run(`update app_session_grants set status='revoked',grant_version=grant_version+1,
      revocation_reason=?,revoked_at=?,updated_at=? where id=? and status in ('provisional','active')`,
      [reason,now.toISOString(),now.toISOString(),grantId])).changes === 1;
    if (changed) {
      const session = (await db.get<{ parent_user_id: string }>("select parent_user_id from learner_sessions where id=?",
        [grant.learner_session_id]))!;
      await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_session_grant_revoked',?)",
        [randomUUID(),session.parent_user_id,JSON.stringify({ grantId, sessionId: grant.learner_session_id,
          appId: grant.app_id, principalId: grant.app_principal_id, reason })]);
    }
    return changed;
  });
}

export async function activeGrantCountForDeployment(appId: string, deploymentId: string) {
  return (await resolveDbClient().get<{ n: number }>(
    `select count(*) n from app_session_grants where app_id=? and deployment_id=? and status='active'`,
    [appId,deploymentId]))!.n;
}

export async function getAppGrantStatus(grantId: string, principalId: string) {
  const db = resolveDbClient();
  const grant = await grantRow(db, grantId);
  if (!grant || grant.app_principal_id !== principalId) throw new AppAuthorizationError("APP_AUTHORIZATION_NOT_FOUND");
  const session = await db.get<{ status: string }>("select status from learner_sessions where id=?",
    [grant.learner_session_id]);
  return { grantId: grant.id, status: grant.status, grantVersion: grant.grant_version,
    expiresAt: grant.expires_at, learnerSessionStatus: session?.status ?? "unavailable",
    scopes: JSON.parse(grant.scopes_json) as string[], apiContractVersion: grant.api_contract_version };
}

export async function purgeExpiredAppGrants(now: Date) {
  const timestamp = now.toISOString();
  return resolveDbClient().transaction(async (db) => {
    const requests = (await db.run("delete from app_session_grant_requests where expires_at<=?", [timestamp])).changes;
    const grants = (await db.run(`delete from app_session_grants where expires_at<=? or learner_session_id in
      (select id from learner_sessions where status not in ('starting','active','disconnected','resumable'))`,
      [timestamp])).changes;
    return requests + grants;
  });
}
