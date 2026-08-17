import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

function between(text: string, start: string, end: string) {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe("PC-001 repository privacy guards", () => {
  it("never persists raw parent email in the BI-004 cancellation queue", () => {
    const billing = source("src/lib/billing/bi004-service.ts");
    expect(billing).not.toContain("recipient_email");
    expect(billing).not.toContain("u.email");

    const migration = source("supabase/migrations/0051_pc001_privacy_minimization.sql");
    expect(migration).toContain("drop column if exists recipient_email");
  });

  it("resolves the current parent email only at the notification delivery boundary", () => {
    const resolver = source("src/lib/billing/notification-recipient.ts");
    expect(resolver).toContain('key: "parent.email"');
    expect(resolver).toContain('consumer: "billing_notification_service"');
    expect(resolver).toContain("join users u on u.id=s.purchaser_parent_id");
    expect(resolver).toContain("select u.email");
  });

  it("keeps raw DOB out of the learning-app bootstrap assertion", () => {
    const launch = source("src/lib/app-launch/service.ts");
    const bootstrap = between(launch, "new SignJWT({", "}).setProtectedHeader");
    expect(bootstrap).toContain("age_years");
    expect(bootstrap).toContain("age_months");
    expect(bootstrap).toContain("age_as_of_date");
    expect(bootstrap).not.toContain("date_of_birth");
  });

  it("keeps permanent analytics free of raw learner identity and DOB", () => {
    const analytics = source("supabase/migrations/0015_an001_analytics.sql");
    const levelAggregate = between(
      analytics,
      "create table analytics_daily_level (",
      "alter table analytics_daily_level enable row level security;",
    );
    const appAggregate = between(
      analytics,
      "create table analytics_daily_app (",
      "alter table analytics_daily_app enable row level security;",
    );
    for (const aggregate of [levelAggregate, appAggregate]) {
      expect(aggregate).not.toContain("learner_id");
      expect(aggregate).not.toContain("parent_user_id");
      expect(aggregate).not.toContain("date_of_birth");
      expect(aggregate).toContain("age_band");
    }
  });

  it("keeps prohibited tracking purposes out of the approved catalog", () => {
    const catalog = source("src/lib/privacy-governance/catalog.ts");
    for (const purpose of [
      'purpose: "advertising"',
      'purpose: "advertising_profile"',
      'purpose: "session_replay"',
      'purpose: "learner_surveillance"',
      'purpose: "behavioral_tracking"',
    ]) {
      expect(catalog).not.toContain(purpose);
    }
  });
});
