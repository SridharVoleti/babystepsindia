import fs from "node:fs";
import { describe, expect, it } from "vitest";

const restorationSource = fs.readFileSync("src/lib/platform-governance/restoration.ts", "utf8");
const auditSource = fs.readFileSync("src/lib/platform-governance/audit-viewer.ts", "utf8");
const recoverySource = fs.readFileSync("src/lib/platform-governance/recovery-sessions.ts", "utf8");
const codesSource = fs.readFileSync("src/lib/platform-governance/recovery-codes.ts", "utf8");
const dashboardSource = fs.readFileSync("src/lib/platform-governance/dashboard.ts", "utf8");
const allSources = [restorationSource, auditSource, recoverySource, codesSource, dashboardSource];

describe("AD-005 frozen architecture", () => {
  it("rules 6-11: never a second business-domain state machine — no direct mutation of support_cases, subscriptions, app_registry, or platform_operation_changes", () => {
    for (const source of allSources) {
      expect(source).not.toMatch(/update\s+support_cases\s+set/i);
      expect(source).not.toMatch(/update\s+subscriptions\s+set/i);
      expect(source).not.toMatch(/update\s+app_registry\s+set/i);
      expect(source).not.toMatch(/update\s+platform_operation_changes\s+set/i);
    }
  });

  it("rule 78/32: no parent impersonation and no unrelated parent-field mutation anywhere in restoration", () => {
    expect(restorationSource).not.toMatch(/impersonat|assume.?parent/i);
    expect(restorationSource).not.toMatch(/update\s+profiles\s+set\s+[a-z_]*(email|password|phone)/i);
  });

  it("rule 82/86: no free-form SQL/filter expression, and no customer email/learner-name search field in the audit viewer", () => {
    expect(auditSource).not.toMatch(/req(uest)?\.(body|query)\.(sql|filter|where)/i);
    expect(auditSource).not.toMatch(/customerEmail|learnerName/i);
  });

  it("rule 92: audit is never edited/deleted/resolved from this module", () => {
    expect(auditSource).not.toMatch(/update\s+(staff_audit_log|support_case_activity|platform_operation_activity)\s+set/i);
    expect(auditSource).not.toMatch(/delete\s+from\s+(staff_audit_log|support_case_activity|platform_operation_activity)/i);
  });

  it("rule 53/56/85: plaintext recovery codes are never persisted, and only a hash column is ever written to platform_recovery_codes", () => {
    const insertMatch = codesSource.match(/insert into platform_recovery_codes\(([^)]*)\)/i) ?? codesSource.match(/insert into platform_recovery_codes \(([^)]*)\)/i);
    expect(insertMatch).toBeTruthy();
    expect(insertMatch![1]).toMatch(/verifier_hash/);
    expect(insertMatch![1]).not.toMatch(/plaintext/);
  });

  it("rule 47/16: no email/SMS/WhatsApp/magic-link recovery bypass anywhere in the recovery-session module", () => {
    for (const source of [recoverySource, codesSource]) {
      expect(source).not.toMatch(/sendSms|sendWhatsapp|magicLink|emailOtp|sendOtp/i);
    }
  });

  it("rule 41/97-98: governance dashboard alerts are read-only counts — never a mutation of staff_accounts", () => {
    expect(dashboardSource).not.toMatch(/update\s+staff_accounts\s+set/i);
  });

  it("no continuous polling, WebSocket, SSE, or Supabase Realtime in the admin platform pages", () => {
    for (const page of [
      "src/app/admin/platform/page.tsx", "src/app/admin/platform/staff/page.tsx", "src/app/admin/platform/audit/page.tsx",
    ]) {
      if (!fs.existsSync(page)) continue;
      const source = fs.readFileSync(page, "utf8");
      expect(source).not.toMatch(/setInterval|setTimeout|EventSource|WebSocket/);
    }
  });

  it("rule 94-95: no bulk audit export / unrestricted data-export route exists", () => {
    expect(fs.existsSync("src/app/v1/admin/platform/audit/export")).toBe(false);
    expect(auditSource).not.toMatch(/csv|xlsx|bulk.?export/i);
  });
});
