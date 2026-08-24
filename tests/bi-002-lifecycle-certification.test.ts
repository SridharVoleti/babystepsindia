import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";

describe("BI-002 lifecycle database certification", () => {
  beforeEach(() => useInMemoryDb());

  it("installs duplicate-event, paid-period and terminal-cancellation boundaries", () => {
    const db = getDb();
    const providerPk = db.prepare("pragma table_info(payment_provider_events)").all() as { name: string; pk: number }[];
    expect(providerPk.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      "provider", "environment", "account_id", "provider_event_id",
    ]);
    const periodIndexes = db.prepare("pragma index_list(billing_periods)").all() as { unique: number }[];
    expect(periodIndexes.some((index) => index.unique === 1)).toBe(true);
    const trigger = db.prepare("select sql from sqlite_master where type='trigger' and name='subscriptions_cancelled_terminal'")
      .get() as { sql: string };
    expect(trigger.sql).toContain("cancelled subscription lifecycle is terminal");
  });
});
