import fs from "node:fs";
import { describe, expect, it } from "vitest";

const billingOrchestrationSource = fs.readFileSync("src/lib/support-cases/billing.ts", "utf8");
const schemaSource = fs.readFileSync("src/lib/db/schema.sql", "utf8");

describe("AD-003 frozen architecture (AT-AD-003-10/11/12/29/42/43/48)", () => {
  it("AT-10/11/12: no generic payment/subscription/entitlement/credit editor, no raw SQL/JSON field editor", () => {
    expect(billingOrchestrationSource).not.toMatch(/update\s+subscriptions\s+set/i);
    expect(billingOrchestrationSource).not.toMatch(/update\s+payments\s+set/i);
    expect(billingOrchestrationSource).not.toMatch(/update\s+learner_app_effective_entitlements\s+set/i);
    expect(billingOrchestrationSource).not.toMatch(/update\s+learner_session_credits\s+set/i);
    expect(billingOrchestrationSource).not.toMatch(/\.rpc\(/);
  });

  it("AT-42: no generic PATCH endpoint exists for subscription/payment/entitlement/credit/invoice/refund", () => {
    expect(fs.existsSync("src/app/v1/admin/support/cases/[caseId]/billing/route.ts")).toBe(true);
    const routeSource = fs.readFileSync("src/app/v1/admin/support/cases/[caseId]/billing/route.ts", "utf8");
    expect(routeSource).not.toMatch(/export async function PATCH/);
    expect(routeSource).not.toMatch(/export async function PUT/);
  });

  it("AT-43: no provider-console proxy endpoint exists anywhere under the billing workspace routes", () => {
    for (const dir of [
      "src/app/v1/admin/support/cases/[caseId]/billing",
      "src/app/v1/admin/support/cases/[caseId]/billing/reassign-subscription",
      "src/app/v1/admin/support/cases/[caseId]/billing/refunds",
    ]) {
      const routeSource = fs.readFileSync(`${dir}/route.ts`, "utf8");
      expect(routeSource).not.toMatch(/razorpay\.com|stripe\.com|provider.?console/i);
    }
  });

  it("AT-48: no authoritative billing_admin_workspace/snapshot table exists — the workspace is composed live", () => {
    expect(schemaSource).not.toMatch(/create table (?:if not exists )?billing_admin_(workspace|snapshot)/i);
    expect(billingOrchestrationSource).not.toMatch(/insert into billing_admin/i);
  });

  it("AT-29/30: no manual grace/cancellation-state edit exists — review only, delegating any real action to BI-003/BI-004", () => {
    expect(billingOrchestrationSource).not.toMatch(/update\s+subscriptions\s+set\s+grace_/i);
    expect(billingOrchestrationSource).not.toMatch(/update\s+subscriptions\s+set\s+cancel/i);
  });
});
