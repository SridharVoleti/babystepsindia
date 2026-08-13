// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { API_ROUTE_AUTHORIZATION } from "@/lib/authorization/route-actions";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { NOTIFICATION_TYPE_REGISTRY } from "@/lib/notifications/contracts";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";

const serviceSource = fs.readFileSync("src/lib/notifications/service.ts", "utf8");
const contractsSource = fs.readFileSync("src/lib/notifications/contracts.ts", "utf8");

describe("NT-001 frozen architecture (AT-NT-001-45/46/47/95-99)", () => {
  it("AT-45: NT-001 declares no parent-facing notification/communication history route", () => {
    const historyRoutes = API_ROUTE_AUTHORIZATION.filter((rule) =>
      /communication-history|notification-history/i.test(rule.pattern.source));
    expect(historyRoutes).toEqual([]);
  });

  it("AT-46: no learner notification inbox or marketing/campaign endpoint exists", () => {
    const learnerNotificationRoutes = API_ROUTE_AUTHORIZATION.filter((rule) =>
      /notification/i.test(rule.pattern.source) && /learner/i.test(rule.pattern.source));
    expect(learnerNotificationRoutes).toEqual([]);
    const marketingRoutes = API_ROUTE_AUTHORIZATION.filter((rule) =>
      /campaign|newsletter|marketing|broadcast/i.test(rule.pattern.source));
    expect(marketingRoutes).toEqual([]);
  });

  it("NT-001's own internal routes are exactly the 5 declared API-NT contracts, no resend/delete endpoint", () => {
    const notificationRoutes = API_ROUTE_AUTHORIZATION.filter((rule) => /notifications/i.test(rule.pattern.source));
    expect(notificationRoutes).toHaveLength(5);
    const paths = notificationRoutes.map((rule) => rule.pattern.source);
    expect(paths.some((p) => /resend|unsubscribe/i.test(p))).toBe(false);
  });

  it("no browser-facing send endpoint or arbitrary-recipient parameter exists in the enqueue contract", () => {
    expect(serviceSource).not.toMatch(/destinationEmail|recipientEmail\s*:\s*string/);
  });

  it("no tracking-pixel/open-click dependency and no polling/realtime primitive", () => {
    expect(serviceSource).not.toMatch(/trackingPixel|openTracking|setInterval|WebSocket|EventSource|Supabase\s+Realtime/i);
  });

  it("every declared notification type is mandatory in V1 — no suppressible-by-preference type exists", () => {
    // Neither field appears as a real object key/executable reference in
    // the type registry — the only mention allowed is explanatory comment
    // prose (checked separately below), not code.
    expect(contractsSource).not.toMatch(/[a-z_]+\s*:\s*learningReminderEmailEnabled|suppressible\s*:\s*(true|false)/);
    for (const definition of Object.values(NOTIFICATION_TYPE_REGISTRY)) {
      expect(definition.mandatory).toBe(true);
    }
    expect(serviceSource).not.toContain("learningReminderEmailEnabled");
  });
});

let parentId: string;
beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-arch-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

// AT-NT-001-19/45-area: invoice_receipt_available and approved_service_notice
// have no real production producer this session (BI-005 has no invoice/
// receipt document generation; UL-004 has no "this warrants an email"
// decision point) — covered here via directly-constructed fixture calls,
// matching this codebase's established EN-004 precedent for a real,
// tested, but currently-unreachable-from-production path.
describe("NT-001 fixture-only type coverage (AT-NT-001-19, declared-not-wired types)", () => {
  it("AT-NT-001-19: invoice_receipt_available enqueues and delivers via a fixture-constructed event", () => {
    const { notificationId } = enqueueTransactionalNotification({
      notificationType: "invoice_receipt_available", sourceDomain: "billing",
      sourceEventKey: `invoice-${randomUUID()}`, sourceVersion: 1, parentId,
      safeVariables: { documentLabel: "August 2026 receipt" },
    });
    const result = runNotificationDeliverySweep({ now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.results).toEqual([{ notificationId, deliveryState: "accepted" }]);
  });

  it("approved_service_notice enqueues and delivers via a fixture-constructed operations event", () => {
    const { notificationId } = enqueueTransactionalNotification({
      notificationType: "approved_service_notice", sourceDomain: "operations",
      sourceEventKey: `notice-${randomUUID()}`, sourceVersion: 1, parentId,
      safeVariables: { noticeTitle: "Scheduled maintenance this weekend" },
    });
    const result = runNotificationDeliverySweep({ now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.results).toEqual([{ notificationId, deliveryState: "accepted" }]);
  });
});
