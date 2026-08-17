import fs from "node:fs";
import { describe, expect, it } from "vitest";

const reportingSource = fs.readFileSync("src/lib/analytics/reporting.ts", "utf8");
const dailyRouteSource = fs.readFileSync("src/app/v1/admin/analytics/daily/route.ts", "utf8");
const exportRouteSource = fs.readFileSync("src/app/v1/admin/analytics/daily/export/route.ts", "utf8");
const pageSource = fs.readFileSync("src/app/admin/analytics/page.tsx", "utf8");

describe("AN-004 frozen architecture", () => {
  it("analytics stays read-only and non-authoritative: no write against any table anywhere in the reporting/route surface", () => {
    for (const source of [reportingSource, dailyRouteSource, exportRouteSource, pageSource]) {
      expect(source).not.toMatch(/(update|delete from|insert into)\s+\w+/i);
    }
  });

  it("no learner-identifying field (learnerId, learner display name, email) ever appears in the reporting module", () => {
    expect(reportingSource).not.toMatch(/learnerId|learner_id|learnerDisplayName|\bemail\b/i);
  });

  it("both the interactive route and the CSV export route compose through the same scoped/suppressed function — no second, unsuppressed read path", () => {
    expect(dailyRouteSource).toContain("composeScopedDailyAnalytics");
    expect(exportRouteSource).toContain("composeScopedDailyAnalyticsCsv");
    expect(exportRouteSource).not.toMatch(/listDailyLevelAggregates|listDailyAppAggregates/);
    expect(dailyRouteSource).not.toMatch(/listDailyLevelAggregates|listDailyAppAggregates/);
  });

  it("the admin page never calls the unsuppressed repo functions directly either", () => {
    expect(pageSource).not.toMatch(/listDailyLevelAggregates|listDailyAppAggregates/);
    expect(pageSource).toContain("composeScopedDailyAnalytics");
  });

  it("cohort suppression threshold is exactly 5, matching the frozen 'minimum cohort size is 5' rule", () => {
    expect(reportingSource).toMatch(/MIN_COHORT_SIZE\s*=\s*5\b/);
  });

  it("the CSV export route requires its own gated action, distinct from (but a subset of) the read action's role", () => {
    expect(exportRouteSource).toContain('"admin.analytics.daily.export"');
  });
});
