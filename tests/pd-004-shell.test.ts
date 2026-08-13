// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import * as attentionService from "@/lib/parent-attention/service";
import { composeParentShellContext } from "@/lib/parent-shell/service";

const now = new Date("2026-08-13T08:00:00.000Z");
let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`pd004-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01");
});

describe("composeParentShellContext", () => {
  it("wraps PD-003's exact badge — the only attention algorithm, not a second one", () => {
    const badge = attentionService.composeParentAttentionBadge(parentId, now);
    const context = composeParentShellContext(parentId, now);
    expect(context.attentionBadge).toEqual(badge);
    expect(context.version).toBe(badge.version);
  });

  it("is a pure read — writes nothing to the database", () => {
    const before = (getDb().prepare("select count(*) as n from learners").get() as { n: number }).n;
    composeParentShellContext(parentId, now);
    const after = (getDb().prepare("select count(*) as n from learners").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
