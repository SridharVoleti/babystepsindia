// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import * as attentionService from "@/lib/parent-attention/service";
import { composeParentShellContext, PARENT_NAV_ITEMS } from "@/lib/parent-shell/service";

const now = new Date("2026-08-13T08:00:00.000Z");
let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`pd004-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01");
});

describe("composeParentShellContext — AT-PD-004-01/07/08/28/47 (API-PD-006)", () => {
  it("AT-PD-004-07: wraps PD-003's exact badge as attentionSummary — the only attention algorithm, not a second one", async () => {
    const badge = await attentionService.composeParentAttentionBadge(parentId, now);
    const context = await composeParentShellContext(parentId, 0, now);
    expect(context.attentionSummary).toEqual(badge);
  });

  it("is a pure read — writes nothing to the database", async () => {
    const before = (getDb().prepare("select count(*) as n from learners").get() as { n: number }).n;
    await composeParentShellContext(parentId, 0, now);
    const after = (getDb().prepare("select count(*) as n from learners").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("AT-PD-004-28: passes the caller-derived modeGeneration through unchanged and reflects it in a distinct shellVersion", async () => {
    const at0 = await composeParentShellContext(parentId, 0, now);
    const at1 = await composeParentShellContext(parentId, 1, now);
    expect(at0.modeGeneration).toBe(0);
    expect(at1.modeGeneration).toBe(1);
    expect(at0.shellVersion).not.toBe(at1.shellVersion);
  });

  it("AT-PD-004-10/G03: navItems come from the one canonical PARENT_NAV_ITEMS source", async () => {
    const context = await composeParentShellContext(parentId, 0, now);
    expect(context.navItems).toEqual(PARENT_NAV_ITEMS);
  });

  it("AT-PD-004-08: attentionSummary failure degrades to undefined without throwing — nav/mode still returned", async () => {
    vi.spyOn(attentionService, "composeParentAttentionBadge").mockImplementation(async () => { throw new Error("boom"); });
    const context = await composeParentShellContext(parentId, 2, now);
    expect(context.attentionSummary).toBeUndefined();
    expect(context.navItems).toEqual(PARENT_NAV_ITEMS);
    expect(context.modeGeneration).toBe(2);
    vi.restoreAllMocks();
  });

  it("AT-PD-004-47: capabilityHints are present but non-authoritative — no new auth table involved", async () => {
    const context = await composeParentShellContext(parentId, 0, now);
    expect(context.capabilityHints).toEqual({ canManageBilling: true, canManageLearners: true });
  });
});
