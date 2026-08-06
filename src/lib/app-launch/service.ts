import { createHash, createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { getDb } from "@/lib/db/client";
import { calculateAge } from "@/lib/learner-profile/validation";
import { issueInitialAppGrant } from "@/lib/app-authorization/service";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { verifyAppClientAssertion } from "@/lib/app-launch/principal";
export { createAppClientAssertion, verifyAppClientAssertion } from "@/lib/app-launch/principal";
export { AppLaunchError } from "@/lib/app-launch/errors";
import { AppLaunchError } from "@/lib/app-launch/errors";

const EXCHANGE_AUDIENCE = "babysteps:app-launch:exchange";
const BOOTSTRAP_ISSUER = "https://babysteps.in";

export type TrustedDeployment = {
  deploymentId: string;
  releaseId: string;
  environment: string;
  origin: string;
  launchPath: string;
  compatibilityPassed: boolean;
  dispatchBlocked: boolean;
};

type SessionRow = {
  id: string; learner_id: string; app_id: string; parent_session_id: string;
  device_session_id: string; status: string; version: number; deployment_id: string | null;
  release_id: string | null; deployment_environment: string | null; deployment_origin: string | null;
  launch_path: string | null; session_expires_at: string | null; parent_user_id: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requireSecret(value: string | undefined, name: string) {
  if (!value || value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return createSecretKey(Buffer.from(value, "utf8"));
}

function validRoute(origin: string, path: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && url.origin === origin && path.startsWith("/") &&
      !path.startsWith("//") && !path.includes("?") && !path.includes("#");
  } catch { return false; }
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function dispatchAppLaunch(input: {
  sessionId: string; actorSessionId: string; deviceSessionId: string; expectedVersion: number;
  idempotencyKey: string; now: Date; deployment: TrustedDeployment;
}) {
  const db = getDb();
  const session = db.prepare("select * from learner_sessions where id=?").get(input.sessionId) as SessionRow | undefined;
  if (!session) throw new AppLaunchError("SESSION_NOT_FOUND");
  if (session.parent_session_id !== input.actorSessionId) throw new AppLaunchError("SESSION_NOT_FOUND");
  if (session.device_session_id !== input.deviceSessionId) throw new AppLaunchError("SESSION_DEVICE_MISMATCH");
  // SC-003: dispatch/exchange operate on the starting/reserved session, before
  // usable launch — not on an already-active one. A disconnected session
  // resumes directly (SC-001) rather than re-dispatching a launch.
  if (session.status !== "starting") throw new AppLaunchError("SESSION_NOT_LAUNCHABLE");
  if (session.version !== input.expectedVersion) throw new AppLaunchError("SESSION_VERSION_CONFLICT");
  const profile = db.prepare("select account_status from profiles where id=?").get(session.parent_user_id) as { account_status: string };
  if (profile.account_status !== "active") throw new AppLaunchError("ACCOUNT_NOT_ACTIVE");
  const app = db.prepare("select registry_status from app_registry where id=?").get(session.app_id) as { registry_status: string } | undefined;
  if (app?.registry_status !== "active") throw new AppLaunchError("APP_NOT_ACTIVE");
  if (input.deployment.dispatchBlocked) throw new AppLaunchError("APP_DEPLOYMENT_WINDOW_BLOCKED");
  if (!input.deployment.compatibilityPassed) throw new AppLaunchError("RELEASE_BACKWARD_COMPATIBILITY_FAILED");
  if (session.deployment_id !== input.deployment.deploymentId || session.release_id !== input.deployment.releaseId ||
      session.deployment_environment !== input.deployment.environment || session.deployment_origin !== input.deployment.origin ||
      session.launch_path !== input.deployment.launchPath) throw new AppLaunchError("SESSION_DEPLOYMENT_MISMATCH");
  if (!validRoute(input.deployment.origin, input.deployment.launchPath)) throw new AppLaunchError("DEPLOYMENT_ROUTE_INVALID");

  const launchCode = randomBytes(32).toString("base64url");
  const launchAttemptId = randomUUID();
  const timestamp = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + 60_000).toISOString();
  const current = db.prepare("select attempt_version from learner_session_launch_state where learner_session_id=?")
    .get(session.id) as { attempt_version: number } | undefined;
  const attemptVersion = (current?.attempt_version ?? 0) + 1;
  const prepareLaunch = db.transaction(() => {
    db.prepare(
      `insert into learner_session_launch_state(learner_session_id,learner_id,app_id,environment,deployment_id,
      release_id,device_session_id,launch_attempt_id,attempt_version,code_hash,code_expires_at,status,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)
     on conflict(learner_session_id) do update set launch_attempt_id=excluded.launch_attempt_id,
      attempt_version=excluded.attempt_version,code_hash=excluded.code_hash,code_expires_at=excluded.code_expires_at,
      status='prepared',exchanged_principal_id=null,exchanged_at=null,updated_at=excluded.updated_at`,
    ).run(session.id, session.learner_id, session.app_id, input.deployment.environment,
      input.deployment.deploymentId, input.deployment.releaseId, session.device_session_id, launchAttemptId,
      attemptVersion, sha256(launchCode), expiresAt, timestamp, timestamp);
    db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_launch_dispatched',?)")
      .run(randomUUID(), session.parent_user_id, JSON.stringify({ sessionId: session.id, appId: session.app_id,
        deploymentId: input.deployment.deploymentId, launchAttemptId, attemptVersion, result: "prepared" }));
  });
  prepareLaunch();

  const nonce = randomBytes(18).toString("base64url");
  const action = `${input.deployment.origin}${input.deployment.launchPath}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<title>Opening your learning app</title></head><body><form id="launch" method="post" action="${escapeHtml(action)}">` +
    `<input type="hidden" name="launchCode" value="${launchCode}"><input type="hidden" name="launchAttemptId" value="${launchAttemptId}">` +
    `<noscript><button type="submit">Continue</button></noscript></form><script nonce="${nonce}">document.getElementById('launch').submit()</script></body></html>`;
  return { launchCode, launchAttemptId, attemptVersion, expiresAt, html, headers: {
    "Cache-Control": "no-store, private", "Pragma": "no-cache", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; form-action ${input.deployment.origin}; frame-ancestors 'none'; base-uri 'none'; script-src 'nonce-${nonce}'`,
  } };
}

export async function exchangeAppLaunch(input: {
  launchCode: string; launchAttemptId: string; exchangeIdempotencyKey: string; clientAssertion: string;
  now: Date; resolveSecret: (keyRef: string) => string | undefined;
}) {
  const auth = await verifyAppClientAssertion(input.clientAssertion, input.now, input.resolveSecret, EXCHANGE_AUDIENCE);
  const db = getDb();
  const replayed = db.prepare("select 1 from app_client_assertion_replays where principal_id=? and jti=?")
    .get(auth.principal.id, auth.jti);
  if (replayed) throw new AppLaunchError("APP_CLIENT_ASSERTION_REPLAYED");
  const requestHash = sha256(JSON.stringify({ launchCodeHash: sha256(input.launchCode), launchAttemptId: input.launchAttemptId }));
  const existing = db.prepare(
    "select request_hash,response_json from app_launch_exchange_receipts where principal_id=? and idempotency_key=?",
  ).get(auth.principal.id, input.exchangeIdempotencyKey) as { request_hash: string; response_json: string } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new AppLaunchError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(existing.response_json) as { bootstrapAssertion: string; bootstrapExpiresAt: string;
      centralSessionExpiresAt: string; platformApiAccess: ReturnType<typeof issueInitialAppGrant> };
  }

  const state = db.prepare("select * from learner_session_launch_state where launch_attempt_id=?")
    .get(input.launchAttemptId) as Record<string, string | number | null> | undefined;
  if (!state || state.code_hash !== sha256(input.launchCode)) throw new AppLaunchError("LAUNCH_CODE_INVALID");
  if (input.now >= new Date(String(state.code_expires_at))) throw new AppLaunchError("LAUNCH_CODE_EXPIRED");
  if (state.status !== "prepared") throw new AppLaunchError("LAUNCH_CODE_ALREADY_USED");
  if (state.app_id !== auth.principal.app_id || state.environment !== auth.principal.environment ||
      state.deployment_id !== auth.principal.deployment_id) throw new AppLaunchError("LAUNCH_CODE_APP_MISMATCH");
  const session = db.prepare("select * from learner_sessions where id=?").get(state.learner_session_id) as SessionRow;
  if (session.status !== "starting") throw new AppLaunchError("SESSION_NOT_LAUNCHABLE");
  if (session.learner_id !== state.learner_id || session.app_id !== state.app_id ||
      session.device_session_id !== state.device_session_id || session.deployment_id !== state.deployment_id ||
      session.release_id !== state.release_id || session.deployment_environment !== state.environment) {
    throw new AppLaunchError("LAUNCH_CODE_APP_MISMATCH");
  }
  const profile = db.prepare("select account_status from profiles where id=?").get(session.parent_user_id) as
    { account_status: string } | undefined;
  const app = db.prepare("select registry_status from app_registry where id=?").get(session.app_id) as
    { registry_status: string } | undefined;
  if (profile?.account_status !== "active" || app?.registry_status !== "active") {
    throw new AppLaunchError("SESSION_NOT_LAUNCHABLE");
  }
  // EN-002 business rule 12: LA-001 exchange re-evaluates effective access
  // fresh before issuing the launch authorization.
  const access = evaluateAccessFresh({ learnerId: session.learner_id, appId: session.app_id,
    environment: session.deployment_environment, useCase: "launch_exchange", now: input.now });
  if (!access.allowed) throw new AppLaunchError("ENTITLEMENT_INACTIVE");
  const learner = db.prepare("select * from learners where id=?").get(session.learner_id) as Record<string, string | null>;
  const ageAsOfDate = input.now.toISOString().slice(0, 10);
  const age = calculateAge(String(learner.date_of_birth), ageAsOfDate);
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const centralExpiry = session.session_expires_at ? Math.floor(new Date(session.session_expires_at).getTime() / 1000) : issuedAt + 120;
  const expiresAt = Math.min(issuedAt + 120, centralExpiry);
  const bootstrapAssertion = await new SignJWT({ learner_session_id: session.id, learner_id: session.learner_id,
    app_id: session.app_id, app_key: (db.prepare("select app_key from app_registry where id=?").get(session.app_id) as { app_key: string }).app_key,
    environment: state.environment, deployment_id: state.deployment_id, release_id: state.release_id,
    display_name: learner.display_name, avatar_id: learner.avatar_id, age_years: age.ageYears,
    age_months: age.ageMonths, age_as_of_date: ageAsOfDate, locale: learner.locale, learner_timezone: learner.timezone,
  }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(BOOTSTRAP_ISSUER)
    .setAudience(auth.principal.client_id).setSubject(session.learner_id).setJti(randomUUID())
    .setIssuedAt(issuedAt).setExpirationTime(expiresAt)
    .sign(requireSecret(process.env.APP_LAUNCH_BOOTSTRAP_SECRET, "APP_LAUNCH_BOOTSTRAP_SECRET"));
  let result!: { bootstrapAssertion: string; bootstrapExpiresAt: string; centralSessionExpiresAt: string;
    platformApiAccess: ReturnType<typeof issueInitialAppGrant> };
  const receiptExpiry = new Date(Math.min(new Date(session.session_expires_at ?? input.now).getTime() + 15 * 60_000,
    input.now.getTime() + 60 * 60_000)).toISOString();
  const run = db.transaction(() => {
    try {
      db.prepare("insert into app_client_assertion_replays(principal_id,jti,expires_at) values(?,?,?)")
        .run(auth.principal.id, auth.jti, auth.expiresAt);
    } catch { throw new AppLaunchError("APP_CLIENT_ASSERTION_REPLAYED"); }
    const consumed = db.prepare(`update learner_session_launch_state set status='exchanged',code_hash=null,code_expires_at=null,
      exchanged_principal_id=?,exchanged_at=?,updated_at=? where learner_session_id=? and status='prepared'`)
      .run(auth.principal.id, input.now.toISOString(), input.now.toISOString(), session.id);
    if (consumed.changes !== 1) throw new AppLaunchError("LAUNCH_CODE_ALREADY_USED");
    // SC-003: the grant is provisional at this point — the session is still
    // starting/reserved. Usable-launch confirmation (after the browser
    // runtime initializes) is what activates the session, consumes the
    // credit and issues the SC-001 envelope; exchange no longer does any of that.
    const platformApiAccess = issueInitialAppGrant({ learnerSessionId: session.id,
      principalId: auth.principal.id, now: input.now });
    result = { bootstrapAssertion, bootstrapExpiresAt: new Date(expiresAt * 1000).toISOString(),
      centralSessionExpiresAt: session.session_expires_at ?? new Date(expiresAt * 1000).toISOString(),
      platformApiAccess };
    db.prepare(`insert into app_launch_exchange_receipts(principal_id,idempotency_key,request_hash,launch_attempt_id,
      response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`)
      .run(auth.principal.id, input.exchangeIdempotencyKey, requestHash, input.launchAttemptId,
        JSON.stringify(result), receiptExpiry, input.now.toISOString());
    db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_launch_exchanged',?)")
      .run(randomUUID(), session.parent_user_id, JSON.stringify({ sessionId: session.id, appId: session.app_id,
        deploymentId: state.deployment_id, launchAttemptId: input.launchAttemptId,
        attemptVersion: state.attempt_version, principalId: auth.principal.id, result: "exchanged" }));
  });
  run();
  return result;
}

export function purgeExpiredLaunchData(now: Date) {
  const db = getDb();
  const timestamp = now.toISOString();
  const run = db.transaction(() => {
    const receipts = db.prepare("delete from app_launch_exchange_receipts where expires_at<=?").run(timestamp).changes;
    const assertions = db.prepare("delete from app_client_assertion_replays where expires_at<=?").run(timestamp).changes;
    const states = db.prepare(`delete from learner_session_launch_state where code_expires_at<=?
      or learner_session_id in (select id from learner_sessions where status not in ('starting','active','disconnected'))`).run(timestamp).changes;
    return receipts + assertions + states;
  });
  return run();
}

export function purgeLaunchDataForSession(sessionId: string) {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`delete from app_session_grant_requests where grant_id in
      (select id from app_session_grants where learner_session_id=?)`).run(sessionId);
    db.prepare("delete from app_session_grants where learner_session_id=?").run(sessionId);
    const receipts = db.prepare(`delete from app_launch_exchange_receipts where launch_attempt_id in
      (select launch_attempt_id from learner_session_launch_state where learner_session_id=?)`).run(sessionId).changes;
    const states = db.prepare("delete from learner_session_launch_state where learner_session_id=?")
      .run(sessionId).changes;
    return receipts + states;
  });
  return run();
}
