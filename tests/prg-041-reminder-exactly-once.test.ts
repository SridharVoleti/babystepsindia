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


// PRG-041 (issue #65): exact-once reminder sends across scheduler instances.
const countRows = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;
const args = (batch: string, key: string, provider: ReminderEmailProvider, version = 1) =>
  ({ parentReminderBatchId: batch, expectedBatchVersion: version, idempotencyKey: key, now: midNow, provider });

describe("PRG-041 multi-instance exactly-once sending", () => {
  it("two schedulers racing on the same ready batch call the provider exactly once", async () => {
    seedApp(); const result = await evaluate(); const capture = captureProvider();
    const settled = await Promise.allSettled([
      sendLearningReminder(args(result.parentBatches[0], "send-a", capture.provider)),
      sendLearningReminder(args(result.parentBatches[0], "send-b", capture.provider)),
      sendLearningReminder(args(result.parentBatches[0], "send-c", capture.provider)),
    ]);
    expect(capture.sent).toHaveLength(1);
    expect(settled.filter((s) => s.status === "fulfilled" && (s.value as { sent: boolean }).sent)).not.toHaveLength(0);
    expect(countRows("select count(*) n from learning_reminder_deliveries")).toBe(1);
    expect(getDb().prepare("select status from learning_reminder_batches").get()).toEqual({ status: "sent" });
  });

  it("a stale existing-delivery read (second instance) still cannot send again", async () => {
    seedApp(); const result = await evaluate(); const capture = captureProvider();
    await sendLearningReminder(args(result.parentBatches[0], "send-1", capture.provider));
    const { resolveDbClient } = await import("@/lib/db-client");
    const { vi } = await import("vitest");
    const client = resolveDbClient(); const real = client.get.bind(client); let hidden = 0;
    const spy = vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/from learning_reminder_deliveries/.test(sql) && hidden < 1) { hidden += 1; return undefined; }
      return real(sql, params as never);
    }) as never);
    await sendLearningReminder(args(result.parentBatches[0], "send-2", capture.provider)).catch(() => undefined);
    spy.mockRestore();
    expect(capture.sent).toHaveLength(1);
    expect(countRows("select count(*) n from learning_reminder_deliveries")).toBe(1);
  });

  it("a provider that throws releases the claim so a later attempt can still send", async () => {
    seedApp(); const result = await evaluate();
    const boom: ReminderEmailProvider = { send() { throw new Error("provider down"); } };
    await expect(sendLearningReminder(args(result.parentBatches[0], "send-x", boom))).rejects.toThrow("provider down");
    expect(getDb().prepare("select status from learning_reminder_batches").get()).toEqual({ status: "ready" });
    const capture = captureProvider();
    const retry = await sendLearningReminder(args(result.parentBatches[0], "send-y", capture.provider, (getDb().prepare("select batch_version v from learning_reminder_batches").get() as { v: number }).v));
    expect(retry).toMatchObject({ sent: true });
    expect(capture.sent).toHaveLength(1);
  });

  it("uncertain provider outcome never produces a second send; reconciliation resolves it", async () => {
    seedApp(); const result = await evaluate(); const capture = captureProvider("uncertain");
    await sendLearningReminder(args(result.parentBatches[0], "send-u", capture.provider));
    await sendLearningReminder(args(result.parentBatches[0], "send-u2", capture.provider)).catch(() => undefined);
    expect(capture.sent).toHaveLength(1);
    const rec = await reconcileLearningReminderDeliveries({ runIdempotencyKey: "rec-1", principalId: "reminder-scheduler", now: midNow, provider: capture.provider });
    expect(rec.delivered).toBe(1);
    expect(capture.sent).toHaveLength(1);                                       // lookup said delivered: no resend
  });

  it("a session completed before send-time suppresses the reminder and nothing is sent", async () => {
    const appId = seedApp(learnerId, 1); const result = await evaluate(); setProgress(appId, 2);
    const capture = captureProvider();
    await expect(sendLearningReminder(args(result.parentBatches[0], "send-s", capture.provider))).resolves.toMatchObject({ status: "suppressed" });
    expect(capture.sent).toHaveLength(0);
  });

  it("reminder failures never touch learning state", async () => {
    const appId = seedApp(); const result = await evaluate();
    const snap = () => JSON.stringify([getDb().prepare("select * from learner_app_week_usage").all(), getDb().prepare("select * from learner_app_effective_entitlements").all()]);
    const before = snap();
    const boom: ReminderEmailProvider = { send() { throw new Error("provider down"); } };
    await sendLearningReminder(args(result.parentBatches[0], "send-z", boom)).catch(() => undefined);
    expect(snap()).toBe(before);
    expect(appId).toBeTruthy();
  });
});
