import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { clearLauncherAccessCache, evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";

const appId = "app-1";

beforeEach(() => {
  useInMemoryDb();
  clearLauncherAccessCache();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "App One");
});

async function learnerWithCoveringPeriod(periodEnd: string) {
  const { user } = await sqliteAuthAdapter.signUp(`gap106-${crypto.randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: crypto.randomUUID() }, "2026-08-09").learner;
  const cycleId = `cycle-${learner.id}`;
  getDb().prepare(`insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,
    assigned_learner_id,product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,
    status,source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
    values(?,?,?,?,?,'product-fixture',1,'[]','2026-08-01T00:00:00.000Z',?,'2026-08-01','ready',?,1,'hash',?,?,1)`)
    .run(cycleId, cycleId, `sub-${cycleId}`, user.id, learner.id, periodEnd, `event-${cycleId}`,
      "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  getDb().prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,
    app_id,product_version,period_start,period_end,status,effective_source_role,created_at)
    values(?,?,?,?,?,1,'2026-08-01T00:00:00.000Z',?,'ready','allocation_bearing',?)`)
    .run(`period-${learner.id}`, cycleId, `sub-${cycleId}`, learner.id, appId, periodEnd, "2026-08-01T00:00:00.000Z");
  recomputeEffectiveEntitlement({ learnerId: learner.id, appId, environment: "production", now: new Date("2026-08-01T00:00:00.000Z") });
  return learner;
}

describe("GAP-106 bounded launcher access cache", () => {
  it("returns the same decision shape as evaluateAccessFresh", async () => {
    const learner = await learnerWithCoveringPeriod("2026-09-01T00:00:00.000Z");
    const now = new Date("2026-08-09T10:00:00.000Z");
    const decision = evaluateAccessForLauncher({ learnerId: learner.id, appId, environment: "production", now });
    expect(decision).toMatchObject({ allowed: true, state: "active", accessUntil: "2026-09-01T00:00:00.000Z" });
  });

  it("serves a cached decision within the TTL window without re-querying the database", async () => {
    const learner = await learnerWithCoveringPeriod("2026-09-01T00:00:00.000Z");
    const now = new Date("2026-08-09T10:00:00.000Z");
    evaluateAccessForLauncher({ learnerId: learner.id, appId, environment: "production", now });

    const prepareSpy = vi.spyOn(getDb(), "prepare");
    const second = evaluateAccessForLauncher({ learnerId: learner.id, appId, environment: "production",
      now: new Date(now.getTime() + 30_000) });
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(second).toMatchObject({ allowed: true, accessUntil: "2026-09-01T00:00:00.000Z" });
    prepareSpy.mockRestore();
  });

  it("expires no later than the entitlement's own accessUntil boundary, even though the TTL cap hasn't elapsed", async () => {
    // Period ends in 10 seconds — well inside the 60s TTL cap.
    const learner = await learnerWithCoveringPeriod("2026-08-09T10:00:10.000Z");
    const now = new Date("2026-08-09T10:00:00.000Z");
    evaluateAccessForLauncher({ learnerId: learner.id, appId, environment: "production", now });

    const prepareSpy = vi.spyOn(getDb(), "prepare");
    // Still before the 60s TTL cap, but past the period's own boundary —
    // must re-evaluate fresh, not serve the stale "allowed" decision.
    const afterBoundary = evaluateAccessForLauncher({ learnerId: learner.id, appId, environment: "production",
      now: new Date("2026-08-09T10:00:11.000Z") });
    expect(prepareSpy).toHaveBeenCalled();
    expect(afterBoundary.allowed).toBe(false);
    prepareSpy.mockRestore();
  });

  it("never bypasses evaluateAccessFresh for Start — this cache is a distinct function entirely", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "src/lib/learning-session/gateway.ts"), "utf8");
    expect(source).not.toContain("evaluateAccessForLauncher");
  });
});
