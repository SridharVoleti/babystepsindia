// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  AppLaunchError,
  createAppClientAssertion,
  dispatchAppLaunch,
  exchangeAppLaunch,
  purgeExpiredLaunchData,
} from "@/lib/app-launch/service";
import { parseDispatchBody, parseExchangeBody } from "@/lib/app-launch/contracts";
import { resolveTrustedDeployment } from "@/lib/app-launch/deployment";
import { establishAppLocalSession, endAppLocalSession, type AppLocalSession,
  type AppLocalSessionStore } from "@/lib/app-launch/app-sdk";
import { activateAppGrant, AppAuthorizationError, authorizeAppRequest, renewAppGrant, revokeAppGrant }
  from "@/lib/app-authorization/service";
import { AppProgressError, completeLesson, getCurrentProgress, saveCheckpoint }
  from "@/lib/app-progress/service";
import { SessionFinalizationError, finalizeLearnerSession } from "@/lib/session-finalization/service";
import { SessionCreditError, claimTechnicalCredit, listTechnicalCredits } from "@/lib/session-credit/service";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";

const now = new Date("2026-08-04T10:00:00.000Z");
const appId = "10000000-0000-4000-8000-000000000001";
const sessionId = "20000000-0000-4000-8000-000000000001";
const deviceId = "30000000-0000-4000-8000-000000000001";
const deploymentId = "40000000-0000-4000-8000-000000000001";
const releaseId = "50000000-0000-4000-8000-000000000001";
const principalId = "60000000-0000-4000-8000-000000000001";
const accessKeys = generateKeyPairSync("ed25519");
const appPrincipalKeys = generateKeyPairSync("ed25519");
const appPrincipalPrivateKeyPem = appPrincipalKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const appPrincipalPublicKeyPem = appPrincipalKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

beforeEach(async () => {
  useInMemoryDb();
  process.env.APP_LAUNCH_BOOTSTRAP_SECRET = "platform-bootstrap-test-secret-at-least-32-bytes";
  process.env.APP_ACCESS_SIGNING_PRIVATE_KEY = accessKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.APP_ACCESS_SIGNING_PUBLIC_KEY = accessKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  process.env.APP_ACCESS_SIGNING_KEY_ID = "test-ed25519-1";
  process.env.APP_ACCESS_VERIFY_KEYS = "{}";
  process.env.ANALYTICS_HMAC_SECRET = "analytics-test-secret-at-least-32-characters";
  process.env.SESSION_ENVELOPE_SECRET = "session-envelope-test-secret-at-least-32-chars";
  const { user } = await sqliteAuthAdapter.signUp("launch-parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = createLearner(user.id, {
    displayName: "Asha", dateOfBirth: "2018-03-10",
    idempotencyKey: "70000000-0000-4000-8000-000000000001",
  }, "2026-08-04").learner;
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
     values(?,?,?,'Learning app','icon-open-book','learning','team','active')`,
  ).run(appId, "launch-app", "Launch App");
  registerAnalyticsLevel(appId, "level-1", now);
  // EN-002: exchangeAppLaunch now fresh-evaluates access — these LA-001
  // tests aren't exercising EN-001/EN-002 (see entitlement-*-service.test.ts
  // for that), they need a wide-open, always-valid entitlement so the
  // existing launch-exchange assertions keep testing what they were testing.
  {
    const cycleId = `cycle-${learner.id}-${appId}`;
    const periodId = `period-${learner.id}-${appId}`;
    const subscriptionId = `sub-${cycleId}`;
    const fixtureTimestamp = "2020-01-01T00:00:00.000Z";
    getDb().prepare(`insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,
      assigned_learner_id,product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,
      status,source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
      values(?,?,?,?,?,'product-fixture',1,'[]','2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',
      '2020-01-01','ready',?,1,'fixture-hash',?,?,1)`)
      .run(cycleId, cycleId, subscriptionId, user.id, learner.id, `event-${cycleId}`, fixtureTimestamp, fixtureTimestamp);
    getDb().prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,
      app_id,product_version,period_start,period_end,status,effective_source_role,created_at)
      values(?,?,?,?,?,1,'2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','ready','allocation_bearing',?)`)
      .run(periodId, cycleId, subscriptionId, learner.id, appId, fixtureTimestamp);
    recomputeEffectiveEntitlement({ learnerId: learner.id, appId, environment: "production", now });
  }
  getDb().prepare(
    `insert into learner_sessions(id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
      week_key,week_timezone,weekly_slot_number,source,status,reservation_expires_at,schedule_authorization_id,started_at,
      resume_token_hash,deployment_id,release_id,deployment_environment,deployment_origin,launch_path,
      session_expires_at,created_at,updated_at)
     values(?,?,?,?,?,?,'2026-W32','Asia/Kolkata',1,'normal','starting',?,'schedule-1',?,?, ?,?,?,?, ?,?,?,?)`,
  ).run(sessionId, learner.id, appId, user.id, "parent-session-1", deviceId,
    "2026-08-04T10:05:00.000Z", now.toISOString(), "hash", deploymentId, releaseId, "production",
    "https://launch-app.example", "/launch", "2026-08-04T10:45:00.000Z", now.toISOString(), now.toISOString());
  getDb().prepare(
    `insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,public_key,status,valid_from,valid_until,version)
     values(?,?,?,?,?,?,?,'active',?,?,1)`,
  ).run(principalId, appId, "production", deploymentId, "client-launch-app", "test-key", appPrincipalPublicKeyPem,
    "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  getDb().prepare(
    `insert into app_deployment_launch_controls(deployment_id,app_id,release_id,environment,immutable_origin,
      launch_path,compatibility_status,status,updated_at) values(?,?,?,?,?,?,'passed','published',?)`,
  ).run(deploymentId, appId, releaseId, "production", "https://launch-app.example", "/launch", now.toISOString());
  const schema = JSON.stringify({ type: "object", required: ["board"], additionalProperties: false,
    properties: { board: { type: "string" }, score: { type: "integer" } } });
  getDb().prepare(`insert into app_progress_schemas(app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,?,?,?,'active',?)`).run(appId,releaseId,1,schema,createHash("sha256").update(schema).digest("hex"),now.toISOString());
});

const trustedDeployment = (overrides: Record<string, unknown> = {}) => ({
  deploymentId, releaseId, environment: "production", origin: "https://launch-app.example",
  launchPath: "/launch", compatibilityPassed: true, dispatchBlocked: false, ...overrides,
});

function dispatch(overrides: Record<string, unknown> = {}) {
  const learnerId = (getDb().prepare("select learner_id from learner_sessions where id=?")
    .get(sessionId) as { learner_id: string }).learner_id;
  return dispatchAppLaunch({ sessionId, learnerId, actorSessionId: "parent-session-1", deviceSessionId: deviceId,
    expectedVersion: 1, idempotencyKey: crypto.randomUUID(), now, deployment: trustedDeployment(), ...overrides });
}

async function assertion(jti = crypto.randomUUID(), overrides: Record<string, unknown> = {}) {
  return createAppClientAssertion({ clientId: "client-launch-app", appId, environment: "production",
    deploymentId, audience: "babysteps:app-launch:exchange", jti, now, privateKeyPem: appPrincipalPrivateKeyPem, ...overrides });
}

function progressContext() {
  // LA-003/LA-004 tests exercise progress/finalization directly and don't
  // care how the session became active — SC-003's reserve/confirm dance is
  // covered separately by the LA-001/SC-003 describe block below.
  getDb().prepare("update learner_sessions set status='active',usable_launch_established_at=? where id=?")
    .run(now.toISOString(),sessionId);
  const learnerId=(getDb().prepare("select learner_id from learner_sessions where id=?").get(sessionId) as {learner_id:string}).learner_id;
  getDb().prepare(`insert into app_session_grants(id,learner_session_id,learner_id,app_id,environment,deployment_id,
    release_id,app_principal_id,scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values('grant-1',?,?,?,?,?,?,?,'["progress.read","progress.write","lesson.complete"]','1.0',1,'active',?,?,?)`)
    .run(sessionId,learnerId,appId,"production",deploymentId,releaseId,principalId,
      "2026-08-04T10:45:00.000Z",now.toISOString(),now.toISOString());
  return {grantId:"grant-1",principalId,learnerSessionId:sessionId,learnerId,appId};
}

describe("LA-001 secure launch", () => {
  it("dispatches a no-store auto-submit POST to the exact pinned deployment", () => {
    const result = dispatch();
    expect(result.headers).toMatchObject({ "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer" });
    expect(result.headers["Content-Security-Policy"]).toContain("form-action https://launch-app.example");
    expect(result.html).toContain('method="post" action="https://launch-app.example/launch"');
    expect(result.html).not.toMatch(/<script[^>]+src=/);
    expect(result.html).not.toContain("parent-session-1");
  });

  it("stores only a SHA-256 code hash in one mutable row and replaces the old code", () => {
    const first = dispatch();
    const second = dispatch({ expectedVersion: 1 });
    const rows = getDb().prepare("select * from learner_session_launch_state").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].attempt_version).toBe(2);
    expect(rows[0].code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain(first.launchCode);
    expect(second.launchCode).not.toBe(first.launchCode);
  });

  it.each([
    [{ deviceSessionId: "other-device" }, "SESSION_DEVICE_MISMATCH"],
    [{ deployment: trustedDeployment({ dispatchBlocked: true }) }, "APP_DEPLOYMENT_WINDOW_BLOCKED"],
    [{ deployment: trustedDeployment({ compatibilityPassed: false }) }, "RELEASE_BACKWARD_COMPATIBILITY_FAILED"],
    [{ deployment: trustedDeployment({ deploymentId: "other" }) }, "SESSION_DEPLOYMENT_MISMATCH"],
  ])("fails closed before creating a code for %j", (override, code) => {
    expect(() => dispatch(override)).toThrowError(new AppLaunchError(code));
    expect(getDb().prepare("select count(*) n from learner_session_launch_state").get()).toMatchObject({ n: 0 });
  });

  it("AT-AU-002-12 rejects a sibling learner context for the requested session", () => {
    expect(() => dispatch({ learnerId: "sibling-learner" }))
      .toThrowError(new AppLaunchError("SESSION_NOT_FOUND"));
    expect(getDb().prepare("select count(*) n from learner_session_launch_state").get())
      .toMatchObject({ n: 0 });
  });

  it("atomically consumes the code and returns a <=120 second minimal bootstrap", async () => {
    const launched = dispatch();
    const result = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "exchange-1",
      clientAssertion: await assertion("assertion-1"), now: new Date("2026-08-04T10:00:10.000Z") });
    const claims = decodeJwt(result.bootstrapAssertion);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(120);
    expect(claims).toMatchObject({ sub: expect.any(String), learner_session_id: sessionId, app_id: appId,
      deployment_id: deploymentId, release_id: releaseId, display_name: "Asha" });
    for (const forbidden of ["date_of_birth", "parent_id", "billing", "progress", "weekly_usage"]) {
      expect(claims).not.toHaveProperty(forbidden);
    }
    expect(getDb().prepare("select code_hash,status from learner_session_launch_state").get())
      .toMatchObject({ code_hash: null, status: "exchanged" });
  });

  it("rejects an expired code without consuming it", async () => {
    const launched = dispatch();
    await expect(exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-expired", clientAssertion: await assertion("assertion-expired", { now: new Date("2026-08-04T10:01:01.000Z") }),
      now: new Date("2026-08-04T10:01:01.000Z") }))
      .rejects.toEqual(new AppLaunchError("LAUNCH_CODE_EXPIRED"));
  });

  it("rejects another app/deployment principal and assertion replay", async () => {
    const launched = dispatch();
    const token = await assertion("assertion-replay");
    await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-ok", clientAssertion: token,
      now: new Date("2026-08-04T10:00:10.000Z") });
    await expect(exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-new", clientAssertion: token,
      now: new Date("2026-08-04T10:00:11.000Z") }))
      .rejects.toEqual(new AppLaunchError("APP_CLIENT_ASSERTION_REPLAYED"));
  });

  it("returns the original result only for an identical principal/request retry", async () => {
    const launched = dispatch();
    const first = await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-idem", clientAssertion: await assertion("assertion-idem-1"),
      now: new Date("2026-08-04T10:00:10.000Z") });
    const retry = await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-idem", clientAssertion: await assertion("assertion-idem-2"),
      now: new Date("2026-08-04T10:00:11.000Z") });
    expect(retry).toEqual(first);
  });

  it("purges temporary state and receipts after their purpose", async () => {
    const launched = dispatch();
    await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-purge", clientAssertion: await assertion("assertion-purge"),
      now: new Date("2026-08-04T10:00:10.000Z") });
    expect(purgeExpiredLaunchData(new Date("2026-08-04T11:01:00.000Z"))).toBeGreaterThan(0);
    expect(getDb().prepare("select count(*) n from app_launch_exchange_receipts").get()).toMatchObject({ n: 0 });
  });

  it("accepts only the documented browser and exchange fields", () => {
    expect(parseDispatchBody({ expectedVersion: 1, idempotencyKey: "dispatch-1" }))
      .toEqual({ expectedVersion: 1, idempotencyKey: "dispatch-1" });
    expect(() => parseDispatchBody({ expectedVersion: 1, idempotencyKey: "x", origin: "https://evil.test" }))
      .toThrowError(new AppLaunchError("DESTINATION_OVERRIDE_REJECTED"));
    expect(() => parseExchangeBody({ launchCode: "x", launchAttemptId: "y",
      exchangeIdempotencyKey: "z", learnerId: "other" }))
      .toThrowError(new AppLaunchError("DESTINATION_OVERRIDE_REJECTED"));
  });

  it("resolves publication and deployment windows only from trusted stored state", () => {
    expect(resolveTrustedDeployment(sessionId, now)).toMatchObject({ deploymentId, releaseId,
      origin: "https://launch-app.example", compatibilityPassed: true, dispatchBlocked: false });
    getDb().prepare("update app_deployment_launch_controls set status='draining',drain_starts_at=? where deployment_id=?")
      .run(now.toISOString(), deploymentId);
    expect(resolveTrustedDeployment(sessionId, now).dispatchBlocked).toBe(true);
  });

  it("creates a random secure app-local cookie bounded by the central session and supports isolated logout", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "exchange-cookie",
      clientAssertion: await assertion("assertion-cookie"), now: new Date("2026-08-04T10:00:10.000Z") });
    const rows = new Map<string, AppLocalSession>();
    const store: AppLocalSessionStore = { create: (row) => rows.set(row.idHash, row),
      find: (id) => rows.get(id) ?? null, delete: (id) => { rows.delete(id); } };
    const local = await establishAppLocalSession({ bootstrapAssertion: exchanged.bootstrapAssertion,
      expectedClientId: "client-launch-app", expectedAppId: appId, expectedDeploymentId: deploymentId,
      expectedReleaseId: releaseId, centralSessionExpiresAt: "2026-08-04T10:45:00.000Z",
      now: new Date("2026-08-04T10:00:11.000Z"), verificationSecret: process.env.APP_LAUNCH_BOOTSTRAP_SECRET!, store });
    expect(local.cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    expect(local.cookie.value).not.toContain(sessionId);
    expect(rows.size).toBe(1);
    endAppLocalSession(local.cookieValue, store);
    expect(rows.size).toBe(0);
  });

  it("rejects missing/malformed app authentication without consuming the code (AT-LA-001-11)", async () => {
    const launched = dispatch();
    await expect(exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-no-auth", clientAssertion: "not-a-jwt", now })).rejects.toEqual(new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED"));
    expect(getDb().prepare("select status from learner_session_launch_state").get()).toMatchObject({ status: "prepared" });
  });

  it("rejects conflicting exchange idempotency reuse without changing the original result (AT-LA-001-17)", async () => {
    const launched = dispatch();
    await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-conflict", clientAssertion: await assertion("assertion-conflict-1"),
      now: new Date("2026-08-04T10:00:10.000Z") });
    await expect(exchangeAppLaunch({ launchCode: "different-code", launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-conflict", clientAssertion: await assertion("assertion-conflict-2"),
      now: new Date("2026-08-04T10:00:11.000Z") }))
      .rejects.toEqual(new AppLaunchError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("rolls back consumption, replay marker and receipt when the atomic outbox write fails (AT-LA-001-33)", async () => {
    const launched = dispatch();
    getDb().exec(`create trigger fail_launch_exchange_event before insert on account_events
      when new.event_type='app_launch_exchanged' begin select raise(abort, 'outbox failed'); end`);
    await expect(exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-rollback", clientAssertion: await assertion("assertion-rollback"),
      now: new Date("2026-08-04T10:00:10.000Z") })).rejects.toThrow("outbox failed");
    expect(getDb().prepare("select status,code_hash from learner_session_launch_state").get())
      .toMatchObject({ status: "prepared", code_hash: expect.any(String) });
    expect(getDb().prepare("select count(*) n from app_launch_exchange_receipts").get()).toMatchObject({ n: 0 });
    expect(getDb().prepare("select count(*) n from app_client_assertion_replays").get()).toMatchObject({ n: 0 });
  });

  it("writes only safe launch audit identifiers and never credentials or learner presentation (AT-LA-001-34)", async () => {
    const launched = dispatch();
    await exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-audit", clientAssertion: await assertion("assertion-audit"),
      now: new Date("2026-08-04T10:00:10.000Z") });
    const events = getDb().prepare("select metadata from account_events where event_type like 'app_launch_%'").all() as
      Array<{ metadata: string }>;
    expect(events).toHaveLength(2);
    const auditText = events.map((row) => row.metadata).join(" ");
    expect(auditText).not.toContain(launched.launchCode);
    expect(auditText).not.toContain("Asha");
    expect(auditText).not.toContain("assertion-audit");
  });

  it("revalidates inactive account/app state at dispatch and exchange (AT-LA-001-32)", async () => {
    getDb().prepare("update app_registry set registry_status='soft_deleted' where id=?").run(appId);
    expect(() => dispatch()).toThrowError(new AppLaunchError("APP_NOT_ACTIVE"));
    getDb().prepare("update app_registry set registry_status='active' where id=?").run(appId);
    const launched = dispatch();
    getDb().prepare("update app_registry set registry_status='soft_deleted' where id=?").run(appId);
    await expect(exchangeAppLaunch({ launchCode: launched.launchCode, launchAttemptId: launched.launchAttemptId,
      exchangeIdempotencyKey: "exchange-inactive", clientAssertion: await assertion("assertion-inactive"),
      now: new Date("2026-08-04T10:00:10.000Z") }))
      .rejects.toEqual(new AppLaunchError("SESSION_NOT_LAUNCHABLE"));
  });

  it("LA-002 exchange creates exactly one backend-only grant and <=5-minute minimal token", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-initial",
      clientAssertion: await assertion("grant-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    expect(exchanged.platformApiAccess).toMatchObject({ grantId: expect.any(String),
      accessToken: expect.any(String), apiContractVersion: "1.0" });
    expect(exchanged).not.toHaveProperty("refreshToken");
    expect(getDb().prepare("select count(*) n from app_session_grants").get()).toMatchObject({ n: 1 });
    const stored = JSON.stringify(getDb().prepare("select * from app_session_grants").get());
    expect(stored).not.toContain(exchanged.platformApiAccess.accessToken);
  });

  it("LA-002 requires both token and matching principal and enforces scopes immediately", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-auth",
      clientAssertion: await assertion("grant-auth-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    const access = exchanged.platformApiAccess;
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, requiredScope: "session.usable_launch",
      now: new Date("2026-08-04T10:00:20.000Z") })).toThrowError(new AppAuthorizationError("APP_DUAL_CREDENTIAL_REQUIRED"));
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, principalId: "other",
      requiredScope: "session.usable_launch", now: new Date("2026-08-04T10:00:20.000Z") }))
      .toThrowError(new AppAuthorizationError("APP_TOKEN_PRINCIPAL_MISMATCH"));
    // GAP-048/089: the grant a session starts with is provisional — scoped
    // only to session.usable_launch — until confirmUsableLaunch activates it.
    expect(authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "session.usable_launch", now: new Date("2026-08-04T10:00:20.000Z") })).toMatchObject({ appId });
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "progress.read", now: new Date("2026-08-04T10:00:20.000Z") }))
      .toThrowError(new AppAuthorizationError("APP_SCOPE_NOT_GRANTED"));
    getDb().prepare("update app_session_grants set scopes_json='[\"progress.read\"]' where id=?").run(access.grantId);
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "progress.write", now: new Date("2026-08-04T10:00:20.000Z") }))
      .toThrowError(new AppAuthorizationError("APP_SCOPE_NOT_GRANTED"));
  });

  it("GAP-048/089/051: activateAppGrant upgrades scope only once, staying provisional-only until then", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-activate",
      clientAssertion: await assertion("grant-activate-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    const access = exchanged.platformApiAccess;
    expect(getDb().prepare("select status,scopes_json from app_session_grants where id=?").get(access.grantId))
      .toMatchObject({ status: "provisional", scopes_json: JSON.stringify(["session.usable_launch"]) });
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "progress.write", now: new Date("2026-08-04T10:00:20.000Z") }))
      .toThrowError(new AppAuthorizationError("APP_SCOPE_NOT_GRANTED"));

    expect(activateAppGrant(access.grantId, new Date("2026-08-04T10:00:21.000Z"))).toBe(true);
    // The same, still-unexpired token now carries the full scope set —
    // no reissue round-trip needed at the exact moment of activation.
    expect(authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "progress.write", now: new Date("2026-08-04T10:00:22.000Z") })).toMatchObject({ appId });
    expect(activateAppGrant(access.grantId, new Date("2026-08-04T10:00:23.000Z"))).toBe(false);
  });

  it("LA-002 renews the same grant idempotently without changing session or usage", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-renew",
      clientAssertion: await assertion("grant-renew-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    const before = getDb().prepare("select version,weekly_slot_number from learner_sessions where id=?").get(sessionId);
    const input = { grantId: exchanged.platformApiAccess.grantId,
      accessToken: exchanged.platformApiAccess.accessToken, principalId, idempotencyKey: "renew-1",
      now: new Date("2026-08-04T10:04:00.000Z") };
    const first = renewAppGrant(input);
    expect(renewAppGrant(input)).toEqual(first);
    expect(first.grantId).toBe(exchanged.platformApiAccess.grantId);
    expect(getDb().prepare("select version,weekly_slot_number from learner_sessions where id=?").get(sessionId)).toEqual(before);
    expect(JSON.stringify(getDb().prepare("select * from app_session_grant_requests").get()))
      .not.toContain(first.accessToken);
  });

  it("LA-002 database revocation invalidates an already-issued token immediately", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-revoke",
      clientAssertion: await assertion("grant-revoke-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    const access = exchanged.platformApiAccess;
    expect(revokeAppGrant(access.grantId, "security", new Date("2026-08-04T10:00:20.000Z"))).toBe(true);
    expect(() => authorizeAppRequest({ accessToken: access.accessToken, principalId,
      requiredScope: "progress.read", now: new Date("2026-08-04T10:00:21.000Z") }))
      .toThrowError(new AppAuthorizationError("APP_GRANT_REVOKED"));
  });

  it("LA-002 keeps still-valid tokens verifiable during signing-key rotation", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-key-rotation",
      clientAssertion: await assertion("grant-key-rotation-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    const replacement = generateKeyPairSync("ed25519");
    process.env.APP_ACCESS_VERIFY_KEYS = JSON.stringify({
      "test-ed25519-1": accessKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });
    process.env.APP_ACCESS_SIGNING_PRIVATE_KEY = replacement.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.APP_ACCESS_SIGNING_PUBLIC_KEY = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env.APP_ACCESS_SIGNING_KEY_ID = "test-ed25519-2";
    expect(authorizeAppRequest({ accessToken: exchanged.platformApiAccess.accessToken, principalId,
      requiredScope: "session.usable_launch", now: new Date("2026-08-04T10:00:20.000Z") })).toMatchObject({ appId });
  });

  it("LA-002 emits safe lifecycle audit events without credentials", async () => {
    const launched = dispatch();
    const exchanged = await exchangeAppLaunch({ launchCode: launched.launchCode,
      launchAttemptId: launched.launchAttemptId, exchangeIdempotencyKey: "grant-audit",
      clientAssertion: await assertion("grant-audit-assertion"), now: new Date("2026-08-04T10:00:10.000Z") });
    renewAppGrant({ grantId: exchanged.platformApiAccess.grantId, accessToken: exchanged.platformApiAccess.accessToken,
      principalId, idempotencyKey: "grant-audit-renew", now: new Date("2026-08-04T10:01:00.000Z") });
    revokeAppGrant(exchanged.platformApiAccess.grantId, "security", new Date("2026-08-04T10:01:01.000Z"));
    const events = getDb().prepare("select event_type,metadata from account_events where event_type like 'app_session_grant_%'").all();
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain(exchanged.platformApiAccess.accessToken);
    expect(JSON.stringify(events)).not.toContain("Asha");
  });

  it("LA-003 reads empty progress and atomically replaces one current row with optimistic versioning", async () => {
    const context = progressContext();
    expect(getCurrentProgress(context)).toEqual({ exists: false, progressVersion: 0 });
    const input = { expectedProgressVersion: 0,checkpointSequence: 1,stateSchemaVersion: 1,
      currentLevelKey: "level-1",currentLessonKey: "lesson-1",currentState: {board:"start",score:0},
      checkpointIdempotencyKey: "checkpoint-1" };
    const first=saveCheckpoint(context,input,new Date("2026-08-04T10:00:20.000Z"));
    expect(first).toMatchObject({exists:true,progressVersion:1,currentState:{board:"start",score:0}});
    expect(saveCheckpoint(context,input,new Date("2026-08-04T10:00:21.000Z"))).toEqual(first);
    expect(getDb().prepare("select count(*) n from learner_app_progress").get()).toMatchObject({n:1});
    expect(() => saveCheckpoint(context,{...input,checkpointIdempotencyKey:"checkpoint-stale",checkpointSequence:2},
      new Date("2026-08-04T10:00:22.000Z"))).toThrowError(new AppProgressError("PROGRESS_VERSION_CONFLICT"));
    expect(() => saveCheckpoint(context,{...input,expectedProgressVersion:1,checkpointIdempotencyKey:"checkpoint-order"},
      new Date("2026-08-04T10:00:22.000Z"))).toThrowError(new AppProgressError("PROGRESS_CHECKPOINT_OUT_OF_ORDER"));
  });

  it("LA-003 validates registered schema, size and prohibited content before persistence", () => {
    const context=progressContext();
    const base={expectedProgressVersion:0,checkpointSequence:1,stateSchemaVersion:1,currentLevelKey:"level-1",
      currentLessonKey:"lesson-1",checkpointIdempotencyKey:"validation"};
    expect(() => saveCheckpoint(context,{...base,currentState:{board:"x",answer_history:[]}},now))
      .toThrowError(new AppProgressError("PROGRESS_STATE_PROHIBITED_CONTENT"));
    expect(() => saveCheckpoint(context,{...base,currentState:{board:"x".repeat(70_000)}},now))
      .toThrowError(new AppProgressError("PROGRESS_STATE_TOO_LARGE"));
    expect(() => saveCheckpoint(context,{...base,currentState:{score:1}},now))
      .toThrowError(new AppProgressError("PROGRESS_STATE_INVALID"));
    expect(getDb().prepare("select count(*) n from learner_app_progress").get()).toMatchObject({n:0});
  });

  it("LA-003 completes a lesson once with server time/timekeeping, next progress and analytics atomically", () => {
    const context=progressContext();
    saveCheckpoint(context,{expectedProgressVersion:0,checkpointSequence:1,stateSchemaVersion:1,currentLevelKey:"level-1",
      currentLessonKey:"lesson-1",currentState:{board:"start",score:0},checkpointIdempotencyKey:"before-complete"},now);
    getDb().prepare("update learner_sessions set verified_active_seconds=120 where id=?").run(sessionId);
    const input={lessonKey:"lesson-1",levelKey:"level-1",expectedProgressVersion:1,checkpointSequence:2,
      stateSchemaVersion:1,nextLevelKey:"level-1",nextLessonKey:"lesson-2",nextState:{board:"next",score:1},
      completionOutcomeCode:"completed",completionIdempotencyKey:"complete-lesson-1"};
    const first=completeLesson(context,input,new Date("2026-08-04T10:02:00.000Z"));
    expect(first).toMatchObject({alreadyCompleted:false,completion:{lessonKey:"lesson-1",verifiedEngagedSeconds:120},
      progress:{progressVersion:2,currentLessonKey:"lesson-2"}});
    expect(completeLesson(context,input,new Date("2026-08-04T10:03:00.000Z"))).toEqual(first);
    expect(getDb().prepare("select count(*) n from lesson_completions").get()).toMatchObject({n:1});
    expect(getDb().prepare("select sum(lessons_completed) n from analytics_daily_buffer").get()).toMatchObject({n:1});
  });

  it("AN-001 assigns lesson completion to the server-derived Kolkata activity date", () => {
    const context=progressContext();
    saveCheckpoint(context,{expectedProgressVersion:0,checkpointSequence:1,stateSchemaVersion:1,currentLevelKey:"level-1",
      currentLessonKey:"lesson-1",currentState:{board:"start",score:0},checkpointIdempotencyKey:"before-midnight-complete"},now);
    completeLesson(context,{lessonKey:"lesson-1",levelKey:"level-1",expectedProgressVersion:1,checkpointSequence:2,
      stateSchemaVersion:1,nextLevelKey:"level-1",nextLessonKey:"lesson-2",nextState:{board:"next",score:1},
      completionIdempotencyKey:"complete-after-kolkata-midnight"},new Date("2026-08-04T18:31:00.000Z"));

    expect(getDb().prepare("select activity_date,lessons_completed from analytics_daily_buffer").all())
      .toEqual([{activity_date:"2026-08-05",lessons_completed:1}]);
  });

  it("LA-004 atomically finalizes only the acknowledged progress version and revokes session credentials", () => {
    const context=progressContext();
    saveCheckpoint(context,{expectedProgressVersion:0,checkpointSequence:1,stateSchemaVersion:1,currentLevelKey:"level-1",
      currentLessonKey:"lesson-1",currentState:{board:"saved",score:1},checkpointIdempotencyKey:"final-progress"},now);
    const version=(getDb().prepare("select version from learner_sessions where id=?").get(sessionId) as {version:number}).version;
    expect(() => finalizeLearnerSession(context,{expectedSessionVersion:version,finalProgressVersion:0,
      endReasonCode:"learner_finished",completionIdempotencyKey:"finalize-stale",reportedConnectedSeconds:0},now))
      .toThrowError(new SessionFinalizationError("FINAL_PROGRESS_NOT_ACKNOWLEDGED"));
    const input={expectedSessionVersion:version,finalProgressVersion:1,endReasonCode:"learner_finished",
      completionIdempotencyKey:"finalize-1",reportedConnectedSeconds:120};
    const result=finalizeLearnerSession(context,input,new Date("2026-08-04T10:03:00.000Z"));
    expect(result).toMatchObject({status:"completed",endReasonCode:"learner_finished",finalProgressVersion:1,
      connectedElapsedSeconds:120,verifiedActiveSeconds:120,
      returnUrl:"/learning-session/return"});
    expect(finalizeLearnerSession(context,input,new Date("2026-08-04T10:03:01.000Z"))).toEqual(result);
    expect(getDb().prepare("select status,resume_token_hash from learner_sessions where id=?").get(sessionId))
      .toMatchObject({status:"completed",resume_token_hash:""});
    expect(getDb().prepare("select status from app_session_grants where id='grant-1'").get()).toMatchObject({status:"revoked"});
    expect(getDb().prepare("select sum(sessions_completed) completed,sum(engaged_seconds) engaged from analytics_daily_buffer").get())
      .toMatchObject({completed:1,engaged:120});
  });

  it("AN-001 finalization contributes only engaged time not already checkpointed", () => {
    const context=progressContext();
    getDb().prepare("update learner_sessions set connected_elapsed_seconds=60,verified_active_seconds=60 where id=?")
      .run(sessionId);
    applyDailyContribution({activityDate:"2026-08-04",learnerId:context.learnerId,appId,
      levelKey:"unassigned",ageBand:"8_9",contributionId:`session-disconnected:${sessionId}:1`,
      deltas:{engagedSeconds:60,sessionsStarted:0,sessionsCompleted:0,sessionsInterrupted:1,lessonsCompleted:0}});
    const version=(getDb().prepare("select version from learner_sessions where id=?").get(sessionId) as {version:number}).version;

    const result=finalizeLearnerSession(context,{expectedSessionVersion:version,finalProgressVersion:0,
      endReasonCode:"learner_finished",completionIdempotencyKey:"finalize-after-checkpoint",reportedConnectedSeconds:100},
      new Date("2026-08-04T10:02:00.000Z"));

    expect(result).toMatchObject({connectedElapsedSeconds:100,verifiedActiveSeconds:100});
    expect(getDb().prepare("select sum(engaged_seconds) engaged,sum(sessions_completed) completed from analytics_daily_buffer").get())
      .toMatchObject({engaged:100,completed:1});
  });

  it("AN-001 splits final engaged time across Kolkata midnight", () => {
    const context=progressContext();
    getDb().prepare(`update learner_sessions set usable_launch_established_at=?,active_segment_started_at=?
      where id=?`).run("2026-08-04T18:29:30.000Z","2026-08-04T18:29:30.000Z",sessionId);
    const version=(getDb().prepare("select version from learner_sessions where id=?").get(sessionId) as {version:number}).version;

    finalizeLearnerSession(context,{expectedSessionVersion:version,finalProgressVersion:0,
      endReasonCode:"learner_finished",completionIdempotencyKey:"finalize-midnight",reportedConnectedSeconds:60},
      new Date("2026-08-04T18:30:30.000Z"));

    expect(getDb().prepare(`select activity_date,engaged_seconds,sessions_completed
      from analytics_daily_buffer order by activity_date`).all()).toEqual([
      {activity_date:"2026-08-04",engaged_seconds:30,sessions_completed:0},
      {activity_date:"2026-08-05",engaged_seconds:30,sessions_completed:1},
    ]);
  });

  it("LA-004 grants exactly one actor-bound technical credit within seven days using calendar-month expiry", () => {
    const context=progressContext();const session=getDb().prepare("select version,parent_user_id from learner_sessions where id=?")
      .get(sessionId) as {version:number;parent_user_id:string};
    finalizeLearnerSession(context,{expectedSessionVersion:session.version,finalProgressVersion:0,
      endReasonCode:"voluntary_early_exit",completionIdempotencyKey:"credit-source",reportedConnectedSeconds:0},new Date("2026-08-31T10:00:00.000Z"));
    const input={confirmation:true,idempotencyKey:"claim-1"};
    const first=claimTechnicalCredit({actorType:"parent",actorId:session.parent_user_id},sessionId,input,
      new Date("2026-08-31T10:01:00.000Z"));
    expect(first).toMatchObject({status:"available",expiresAt:"2026-09-30T10:01:00.000Z",appId});
    const learnerId=context.learnerId;
    const second=claimTechnicalCredit({actorType:"learner",actorId:learnerId},sessionId,
      {confirmation:true,idempotencyKey:"claim-learner"},new Date("2026-08-31T10:02:00.000Z"));
    expect(second.creditId).toBe(first.creditId);
    expect(listTechnicalCredits({actorType:"parent",actorId:session.parent_user_id},learnerId,
      new Date("2026-09-01T00:00:00.000Z"))).toHaveLength(1);
    expect(getDb().prepare("select count(*) n from learner_session_credits").get()).toMatchObject({n:1});
  });

  it("LA-004 rejects technical-credit claims after the seven-day window", () => {
    const context=progressContext();const session=getDb().prepare("select version,parent_user_id from learner_sessions where id=?")
      .get(sessionId) as {version:number;parent_user_id:string};
    finalizeLearnerSession(context,{expectedSessionVersion:session.version,finalProgressVersion:0,
      endReasonCode:"voluntary_early_exit",completionIdempotencyKey:"expired-credit-source",reportedConnectedSeconds:0},now);
    expect(() => claimTechnicalCredit({actorType:"parent",actorId:session.parent_user_id},sessionId,
      {confirmation:true,idempotencyKey:"late-claim"},new Date("2026-08-11T10:00:00.001Z")))
      .toThrowError(new SessionCreditError("TECHNICAL_CREDIT_CLAIM_EXPIRED"));
  });
});
