import { describe, expect, it } from "vitest";
import {
  authorizeAnalyticsView,
  type AnalyticsActor,
  type AnalyticsScope,
} from "@/lib/analytics-reporting/access";
import {
  applyCohortSuppression,
  exportAggregateCsv,
  type AggregateAnalyticsRow,
} from "@/lib/analytics-reporting/reporting";

const allScope: AnalyticsScope = { apps: "all", levels: "all", ageBands: "all", canExport: true };
const supportScope: AnalyticsScope = { apps: ["app-math"], levels: "all", ageBands: ["10_12"], canExport: false };
const superAdmin: AnalyticsActor = { userId: "admin-1", role: "super_admin", scopes: [allScope] };
const limitedAdmin: AnalyticsActor = { userId: "admin-2", role: "analytics_viewer", scopes: [supportScope] };

const rows: AggregateAnalyticsRow[] = [
  { activityDate: "2026-08-16", appId: "app-math", levelKey: "L1", ageBand: "10_12", activeLearners: 7, sessionsStarted: 8, sessionsCompleted: 6, engagedSeconds: 1200, lessonsCompleted: 5 },
  { activityDate: "2026-08-16", appId: "app-math", levelKey: "L2", ageBand: "10_12", activeLearners: 4, sessionsStarted: 4, sessionsCompleted: 3, engagedSeconds: 650, lessonsCompleted: 3 },
  { activityDate: "2026-08-16", appId: "app-chess", levelKey: "L1", ageBand: "10_12", activeLearners: 9, sessionsStarted: 10, sessionsCompleted: 8, engagedSeconds: 1800, lessonsCompleted: 7 },
];

describe("AN-004 analytics access and reporting", () => {
  it("AT-AN-004-01 denies non-Super-Admin analytics outside explicitly assigned scope", () => {
    expect(authorizeAnalyticsView(superAdmin, { appId: "app-chess", levelKey: "L9", ageBand: "16_18", exportRequested: false }).allowed).toBe(true);
    expect(authorizeAnalyticsView(limitedAdmin, { appId: "app-math", levelKey: "L2", ageBand: "10_12", exportRequested: false }).allowed).toBe(true);
    expect(authorizeAnalyticsView(limitedAdmin, { appId: "app-chess", levelKey: "L1", ageBand: "10_12", exportRequested: false })).toEqual({ allowed: false, reason: "ANALYTICS_SCOPE_DENIED" });
    expect(authorizeAnalyticsView(limitedAdmin, { appId: "app-math", levelKey: "L1", ageBand: "13_15", exportRequested: false })).toEqual({ allowed: false, reason: "ANALYTICS_SCOPE_DENIED" });
  });

  it("AT-AN-004-02 suppresses every cohort below five and exposes no learner identifier", () => {
    const visible = applyCohortSuppression(rows);
    expect(visible).toHaveLength(2);
    expect(visible.some((row) => row.levelKey === "L2")).toBe(false);
    expect(JSON.stringify(visible)).not.toMatch(/learnerId|learner_id|email|phone|displayName/i);
  });

  it("AT-AN-004-03 aggregate CSV inherits authorization, filters and cohort suppression", () => {
    expect(() => exportAggregateCsv({ actor: limitedAdmin, rows, request: { appId: "app-math", ageBand: "10_12" } })).toThrowError("ANALYTICS_EXPORT_DENIED");
    const csv = exportAggregateCsv({ actor: superAdmin, rows, request: { appId: "app-math", ageBand: "10_12" } });
    expect(csv).toContain("app-math");
    expect(csv).not.toContain("app-chess");
    expect(csv).not.toContain(",L2,");
    expect(csv).not.toMatch(/learner|email|phone/i);
  });

  it("AN-004 analytics remains read-only and non-authoritative", () => {
    const reporting = require("@/lib/analytics-reporting/reporting") as Record<string, unknown>;
    expect(Object.keys(reporting).sort()).toEqual(["applyCohortSuppression", "exportAggregateCsv"]);
  });
});
