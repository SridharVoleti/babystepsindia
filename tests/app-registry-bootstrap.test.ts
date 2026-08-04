import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { bootstrapInitialApps } from "@/lib/app-registry/bootstrap";

let ADMIN: string;

beforeEach(async () => {
  useInMemoryDb();
  ADMIN = (await sqliteAuthAdapter.signUp("bootstrap-admin@example.com", "CorrectHorse1!")).user.id;
});

describe("bootstrapInitialApps (AC8/AT-AR-001-09)", () => {
  it("registers Chess Master, Magical Math, and Speed Reader as draft apps", () => {
    const apps = bootstrapInitialApps(ADMIN);
    expect(apps).toHaveLength(3);
    expect(apps.map((a) => a.appKey).sort()).toEqual(["chess-master", "magical-math", "speed-reader"]);
    expect(apps.every((a) => a.registryStatus === "draft")).toBe(true);
  });

  it("goes through the same createApp service — not a bypass (rows carry a create audit event)", () => {
    const apps = bootstrapInitialApps(ADMIN);
    for (const app of apps) {
      const events = getDb()
        .prepare("select operation from app_registry_audit_log where app_id = ?")
        .all(app.id) as { operation: string }[];
      expect(events).toEqual([{ operation: "create" }]);
    }
  });

  it("is idempotent — re-running produces no duplicates", () => {
    bootstrapInitialApps(ADMIN);
    bootstrapInitialApps(ADMIN);

    const count = (getDb().prepare("select count(*) as n from app_registry").get() as { n: number }).n;
    expect(count).toBe(3);
  });
});
