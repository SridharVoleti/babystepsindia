// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { isoWeekKey } from "@/lib/learning-session/week";
import { evaluateLearningReminders, sendLearningReminder, type ReminderEmailProvider } from "@/lib/learning-reminders/service";

// Real-PostgreSQL evidence for PRG-041 / EG-006 (issue #65): runs only when PG_TEST_URL points at a disposable, fully migrated database.
// Scheduler instances are simulated by concurrent calls over separate pooled connections - there is no in-process lock around sending.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const midNow = new Date("2026-08-13T08:00:00.000Z");

suite("PRG-041 reminders on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let parentId: string; let learnerId: string; let appId: string; let principalId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    principalId = randomUUID();
    await db().run(`insert into platform_service_principals(id, service_key, key_ref, status, valid_from, valid_until)
      values (?, ?, 'key', 'active', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`, [principalId, `pg041-${principalId}`]);
    parentId = randomUUID(); learnerId = randomUUID(); appId = randomUUID();
    await db().run("insert into users(id, email, password_hash, email_verified_at) values (?, ?, 'x', now())", [parentId, `pg041-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, 'Asha', 'asha', '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, 'pg041-app', 'Reminder App', 'Learning app', 'active')", [appId]);
    await db().run(`insert into learner_app_effective_entitlements(id, learner_id, app_id, environment, state, access_until, effective_version, source_set_hash)
      values (?, ?, ?, 'production', 'active', '2026-09-01T00:00:00.000Z', 1, 'source')`, [randomUUID(), learnerId, appId]);
    await db().run(`insert into learner_app_week_usage(learner_id, app_id, week_key, week_timezone, normal_sessions_started, standard_sessions_funded, version, updated_at)
      values (?, ?, ?, 'Asia/Kolkata', 0, 0, 1, ?)`, [learnerId, appId, isoWeekKey(midNow, "Asia/Kolkata"), midNow.toISOString()]);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  const counting = () => {
    const sent: string[] = [];
    const provider: ReminderEmailProvider = { send(input) { sent.push(input.to); return { status: "accepted", providerMessageId: "m-1" }; }, lookup: () => ({ status: "delivered" }) };
    return { provider, sent };
  };

  it("evaluates a ready batch, then racing schedulers call the provider exactly once", async () => {
    const result = await evaluateLearningReminders({ reminderStage: "mid_window", limit: 20, runIdempotencyKey: `run-${randomUUID()}`, principalId, now: midNow });
    expect(result.parentBatches).toHaveLength(1);
    const batch = result.parentBatches[0];
    const { provider, sent } = counting();
    const settled = await Promise.allSettled([1, 2, 3, 4].map((i) =>
      sendLearningReminder({ parentReminderBatchId: batch, expectedBatchVersion: 1, idempotencyKey: `send-${i}`, now: midNow, provider })));
    expect(sent).toHaveLength(1);
    expect(settled.some((s) => s.status === "fulfilled" && (s.value as { sent: boolean }).sent)).toBe(true);
    const deliveries = await db().get<{ n: string }>("select count(*) n from learning_reminder_deliveries where batch_id = ?", [batch]);
    expect(Number(deliveries!.n)).toBe(1);
    const status = await db().get<{ status: string }>("select status from learning_reminder_batches where id = ?", [batch]);
    expect(status!.status).toBe("sent");
  });
});
