// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { isoWeekKey } from "@/lib/learning-session/week";
import { LEARNING_REMINDER_API_CONTRACTS } from "@/lib/learning-reminders/api-contracts";
import { evaluateLearningReminders, getParentNotificationPreference, listLearningCadenceAttention,
  purgeLearningReminderMetadata, reconcileLearningReminderDeliveries, renderLearningReminderEmail,
  sendLearningReminder, updateParentNotificationPreference, type ReminderEmailProvider } from
  "@/lib/learning-reminders/service";

const midNow = new Date("2026-08-13T08:00:00.000Z");
const finalNow = new Date("2026-08-16T00:00:00.000Z");
let parentId: string;
let learnerId: string;
let appCounter = 0;

function weeklyKey(now = midNow) { return isoWeekKey(now, "Asia/Kolkata"); }

function seedApp(learner = learnerId, progress: 0 | 1 | 2 = 0, name?: string) {
  const suffix = ++appCounter; const appId = `app-eg006-${suffix}`;
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`)
    .run(appId, appId, name ?? `Learning App ${suffix}`);
  getDb().prepare(`insert into learner_app_effective_entitlements
    (id,learner_id,app_id,environment,state,access_until,effective_version,source_set_hash,created_at,updated_at)
    values(?,?,?,'production','active','2026-09-01T00:00:00.000Z',1,'source',?,?)`)
    .run(`effective-${appId}-${learner}`, learner, appId, midNow.toISOString(), midNow.toISOString());
  getDb().prepare(`insert into learner_app_week_usage
    (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
    values(?,?,?,'Asia/Kolkata',0,?,?,?)`).run(learner, appId, weeklyKey(), progress, progress + 1, midNow.toISOString());
  return appId;
}

function setProgress(appId: string, progress: number, learner = learnerId) {
  getDb().prepare(`update learner_app_week_usage set standard_sessions_funded=?,version=version+1,updated_at=?
    where learner_id=? and app_id=? and week_key=?`).run(progress, finalNow.toISOString(), learner, appId, weeklyKey());
}

async function evaluate(stage: "mid_window" | "final_window" = "mid_window", now = midNow, key: string = randomUUID()) {
  return await evaluateLearningReminders({ reminderStage: stage, limit: 20, runIdempotencyKey: key,
    principalId: "reminder-scheduler", now });
}

function captureProvider(result: "accepted" | "delivered" | "uncertain" | "failed" = "accepted") {
  const sent: Parameters<ReminderEmailProvider["send"]>[0][] = [];
  const provider: ReminderEmailProvider = { send(input) { sent.push(input);
    return { status: result, providerMessageId: "provider-message-1" }; },
    lookup: () => ({ status: "delivered" }) };
  return { provider, sent };
}

beforeEach(async () => {
  useInMemoryDb(); appCounter = 0;
  const { user } = await sqliteAuthAdapter.signUp(`eg006-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("EG-006 parent learning reminders", () => {
  it("AT-EG-006-01..04 routes only to the verified parent email and creates no learner channel", async () => {
    seedApp(); const result = await evaluate(); const capture = captureProvider();
    await sendLearningReminder({ parentReminderBatchId: result.parentBatches[0], expectedBatchVersion: 1,
      idempotencyKey: "send-parent", now: midNow, provider: capture.provider });
    expect(capture.sent[0].to).toMatch(/^eg006-/);
    expect(capture.sent[0].to).toMatch(/@example\.com$/);
    expect(Object.keys(getDb().prepare("select * from learners where id=?").get(learnerId)!))
      .not.toEqual(expect.arrayContaining(["email", "phone", "mobile", "push_token"]));
    expect(capture.sent).toHaveLength(1);
  });

  it("AT-EG-006-05..10 reminds only normal 0/2 and 1/2 cadence, never 2/2/catch-up/technical/resume", async () => {
    seedApp(learnerId, 0, "Math"); seedApp(learnerId, 1, "Chess"); seedApp(learnerId, 2, "Reading");
    const result = await evaluate();
    const stored = getDb().prepare(`select remaining_normal_sessions from learning_reminder_items
      order by remaining_normal_sessions desc`).all() as { remaining_normal_sessions: number }[];
    expect(stored.map((row) => row.remaining_normal_sessions)).toEqual([2, 1]);
    expect(result.itemCount).toBe(2);
    expect(getDb().prepare("select count(*) n from learning_reminder_items").get()).toMatchObject({ n: 2 });
  });

  it("AT-EG-006-11/12 performs a final fresh recheck and suppresses an empty email", async () => {
    const appId = seedApp(learnerId, 1); const result = await evaluate(); setProgress(appId, 2);
    const capture = captureProvider();
    expect(await sendLearningReminder({ parentReminderBatchId: result.parentBatches[0], expectedBatchVersion: 1,
      idempotencyKey: "complete-race", now: midNow, provider: capture.provider })).toMatchObject({ status: "suppressed" });
    expect(capture.sent).toHaveLength(0);
    expect(getDb().prepare("select count(*) n from learning_reminder_deliveries").get()).toMatchObject({ n: 0 });
  });

  it("AT-EG-006-13..16 suppresses ended/security/infeasible apps and permits a neutral brief-outage note", async () => {
    const ended = seedApp(learnerId, 0, "Ended");
    getDb().prepare("update learner_app_effective_entitlements set state='inactive' where app_id=?").run(ended);
    const blocked = seedApp(learnerId, 0, "Blocked");
    getDb().prepare("update app_launch_availability set operational_state='security_blocked' where app_id=?").run(blocked);
    const infeasible = seedApp(learnerId, 0, "Long outage");
    getDb().prepare(`update app_launch_availability set operational_state='temporarily_unavailable',expected_return_at=?
      where app_id=?`).run("2026-08-16T17:30:00.000Z", infeasible);
    const brief = seedApp(learnerId, 0, "Brief outage");
    getDb().prepare(`update app_launch_availability set operational_state='temporarily_unavailable',expected_return_at=?
      where app_id=?`).run("2026-08-13T12:00:00.000Z", brief);
    const result = await evaluate();
    expect(result.itemCount).toBe(1);
    expect(getDb().prepare("select availability_note from learning_reminder_items").get())
      .toMatchObject({ availability_note: expect.stringMatching(/temporarily unavailable/i) });
  });

  it("AT-EG-006-17/18/19/42 evaluates read-only and renders only safe names/counts plus a normal account link", async () => {
    seedApp(learnerId, 0, "Math & Shapes");
    const before = { usage: getDb().prepare("select * from learner_app_week_usage").all(),
      sessions: getDb().prepare("select * from learner_sessions").all(),
      credits: getDb().prepare("select * from learner_app_standard_credit_batches").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all() };
    await evaluate();
    const after = { usage: getDb().prepare("select * from learner_app_week_usage").all(),
      sessions: getDb().prepare("select * from learner_sessions").all(),
      credits: getDb().prepare("select * from learner_app_standard_credit_batches").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all() };
    expect(after).toEqual(before);
    const email = renderLearningReminderEmail([{ learnerName: "Asha <safe>", appName: "Math & Shapes",
      remainingNormalSessions: 2 }], "https://babysteps.in/account");
    expect(email.html).toContain("Asha &lt;safe&gt;");
    expect(email.html).toContain("https://babysteps.in/account");
    expect(email.html).not.toMatch(/token|passkey|date of birth|payment method|raw progress/i);
  });

  it("AT-EG-006-20..24 uses neutral weekly wording and consolidates/deduplicates all same-parent items", async () => {
    const secondLearner = (await createLearner(parentId, { displayName: "Ravi", dateOfBirth: "2017-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    seedApp(learnerId, 0, "Math"); seedApp(learnerId, 1, "Chess"); seedApp(secondLearner, 0, "Reading");
    const result = await evaluate(); const capture = captureProvider();
    await sendLearningReminder({ parentReminderBatchId: result.parentBatches[0], expectedBatchVersion: 1,
      idempotencyKey: "consolidate", now: midNow, provider: capture.provider });
    expect(capture.sent).toHaveLength(1);
    expect(capture.sent[0].text).toMatch(/Asha[\s\S]*Chess[\s\S]*Math[\s\S]*Ravi[\s\S]*Reading/);
    expect(capture.sent[0].text).not.toMatch(/failed|streak.*die|daily|third session|extra session|xp|leaderboard/i);
    expect(getDb().prepare("select count(*) n from learning_reminder_items").get()).toMatchObject({ n: 3 });
  });

  it("AT-EG-006-25..29 enforces exact mid/final boundaries, only two stages, and stage idempotency", async () => {
    seedApp();
    expect((await evaluate("mid_window", new Date("2026-08-12T00:00:00Z"), "too-early")).itemCount).toBe(0);
    const mid = await evaluate("mid_window", midNow, "mid");
    expect(await evaluate("mid_window", midNow, "mid")).toEqual(mid);
    expect((await evaluate("mid_window", finalNow, "mid-again")).itemCount).toBe(0);
    expect((await evaluate("final_window", new Date("2026-08-15T00:00:00Z"), "final-early")).itemCount).toBe(0);
    expect((await evaluate("final_window", finalNow, "final")).itemCount).toBe(1);
    expect(getDb().prepare("select count(*) n from learning_reminder_items").get()).toMatchObject({ n: 2 });
  });

  it("AT-EG-006-28 does not pull a not-yet-due parent into another parent's consolidated batch", async () => {
    seedApp();
    const { user } = await sqliteAuthAdapter.signUp(`utc-${randomUUID()}@example.com`, "CorrectHorse1!");
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00Z", user.id);
    getDb().prepare("update profiles set timezone='America/Los_Angeles' where id=?").run(user.id);
    const learner = (await createLearner(user.id, { displayName: "Maya", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    const app = seedApp(learner, 0, "Different boundary");
    getDb().prepare("update learner_app_week_usage set week_key=?,week_timezone='America/Los_Angeles' where app_id=?")
      .run(isoWeekKey(midNow, "America/Los_Angeles"), app);
    const result = await evaluate("mid_window", midNow, "different-boundaries");
    expect(result.parentBatches.length).toBeGreaterThanOrEqual(1);
    const parents = getDb().prepare("select distinct parent_id from learning_reminder_batches").all();
    expect(parents.length).toBe(result.parentBatches.length);
  });

  it("AT-EG-006-30/31 reconciles provider uncertainty without a duplicate or tracking stream", async () => {
    seedApp(); const batch = (await evaluate()).parentBatches[0]; const capture = captureProvider("uncertain");
    await sendLearningReminder({ parentReminderBatchId: batch, expectedBatchVersion: 1,
      idempotencyKey: "uncertain", now: midNow, provider: capture.provider });
    const result = await reconcileLearningReminderDeliveries({ batchId: batch, limit: 20,
      runIdempotencyKey: "reconcile", principalId: "reminder-reconciler", now: midNow, provider: capture.provider });
    expect(result.delivered).toBe(1); expect(capture.sent).toHaveLength(1);
    expect(renderLearningReminderEmail([{ learnerName: "A", appName: "B", remainingNormalSessions: 1 }]).html)
      .not.toMatch(/tracking|pixel|open[_-]?event|click[_-]?event/i);
  });

  it("AT-EG-006-32..37 defaults on, gives only the parent versioned control, and leaves transactional mail separate", async () => {
    expect(await getParentNotificationPreference(parentId, midNow)).toMatchObject({
      learningReminderEmailEnabled: true, version: 1 });
    const disabled = await updateParentNotificationPreference(parentId, { learningReminderEmailEnabled: false,
      expectedVersion: 1, idempotencyKey: "disable", now: midNow });
    expect(await updateParentNotificationPreference(parentId, { learningReminderEmailEnabled: false,
      expectedVersion: 1, idempotencyKey: "disable", now: finalNow })).toEqual(disabled);
    seedApp(); expect((await evaluate()).batchCount).toBe(0);
    expect(AUTHORIZATION_ACTIONS["parent.notification_preferences.update"].mode).toBe("parent_management");
    expect(JSON.stringify(AUTHORIZATION_ACTIONS)).not.toMatch(/admin\.notification|app\.notification/);
    expect(getDb().prepare("select count(*) n from billing_cancellation_notifications").get()).toMatchObject({ n: 0 });
  });

  it("AT-EG-006-38..40 resolves current verified identity at send time and suppresses inactive parents", async () => {
    seedApp(); const batch = (await evaluate()).parentBatches[0];
    getDb().prepare("update users set email='new-parent@example.com',email_verified_at=? where id=?")
      .run("2026-08-13T07:00:00Z", parentId);
    const capture = captureProvider();
    await sendLearningReminder({ parentReminderBatchId: batch, expectedBatchVersion: 1,
      idempotencyKey: "new-email", now: midNow, provider: capture.provider });
    expect(capture.sent[0].to).toBe("new-parent@example.com");
    const secondApp = seedApp(); const next = await evaluate("final_window", finalNow, "inactive-parent");
    expect(secondApp).toBeTruthy();
    if (next.parentBatches[0]) {
      getDb().prepare("update profiles set account_status='suspended' where id=?").run(parentId);
      expect(await sendLearningReminder({ parentReminderBatchId: next.parentBatches[0], expectedBatchVersion: 1,
        idempotencyKey: "suspended", now: finalNow, provider: capture.provider })).toMatchObject({ status: "suppressed" });
    }
  });

  it("AT-EG-006-41/43 keeps metadata at most 90 days with scheduled bounded reads only", async () => {
    seedApp(); await evaluate();
    getDb().prepare("update learning_reminder_batches set created_at='2026-01-01T00:00:00.000Z'").run();
    expect((await purgeLearningReminderMetadata(new Date("2026-08-13T00:00:00Z"), 20)).deletedBatches).toBe(1);
    expect(getDb().prepare("select count(*) n from learning_reminder_items").get()).toMatchObject({ n: 0 });
    const source = readFileSync("src/lib/learning-reminders/service.ts", "utf8");
    expect(source).not.toMatch(/setInterval|WebSocket|EventSource|Supabase\s+Realtime|heartbeat/i);
  });

  it("AT-EG-006-44 isolates an unreadable app while retaining other safe items", async () => {
    const broken = seedApp(learnerId, 0, "Broken"); seedApp(learnerId, 1, "Safe");
    getDb().prepare("delete from app_launch_availability where app_id=?").run(broken);
    expect((await evaluate()).itemCount).toBe(1);
    expect(getDb().prepare("select count(*) n from learning_reminder_items").get()).toMatchObject({ n: 1 });
  });

  it("AT-EG-006-45..48 declares responsive parent settings, no learner controls, and cadence-only triggers", async () => {
    seedApp(); await updateParentNotificationPreference(parentId, { learningReminderEmailEnabled: false,
      expectedVersion: 1, idempotencyKey: "attention-independent", now: midNow });
    expect(await listLearningCadenceAttention(parentId, "mid_window", midNow)).toHaveLength(1);
    const component = readFileSync("src/components/account/learning-reminder-preference.tsx", "utf8");
    const learner = readFileSync("src/components/learner-home/learner-launcher.tsx", "utf8");
    expect(component).toMatch(/sm:flex-row/); expect(component).toMatch(/min-h-\[44px\]/);
    expect(component).toContain("email you—not the learner");
    expect(learner).not.toMatch(/notification preference|learner email|learner phone/i);
    expect(resolveApiRouteAuthorization("PATCH", "/v1/parent/notification-preferences"))
      .toBe("parent.notification_preferences.update");
    expect(Object.values(LEARNING_REMINDER_API_CONTRACTS)).toHaveLength(4);
    expect(readFileSync("src/lib/achievements/service.ts", "utf8")
      + readFileSync("src/lib/journey/service.ts", "utf8")).not.toMatch(/evaluateLearningReminders|sendLearningReminder/);
  });
});
