// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { AppAvailabilityError, SAFE_START_SECONDS, assertStartAvailability, readAppAvailability,
  scheduleMaintenanceWindow, setSecurityAvailability, transitionAvailability, updateMaintenanceWindow } from
  "@/lib/app-availability/service";

const appId = "ul004-app";
const now = new Date("2026-08-11T10:00:00.000Z");

beforeEach(() => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status)
    values(?,?,?,'active')`).run(appId, appId, "UL004 App");
});

function schedule(offsetSeconds: number, key = `key-${offsetSeconds}`) {
  return scheduleMaintenanceWindow({ appId, environment: "production",
    startsAt: new Date(now.getTime() + offsetSeconds * 1000),
    endsAt: new Date(now.getTime() + (offsetSeconds + 1_800) * 1000),
    reasonCategory: "planned_maintenance", learnerMessage: "A short planned update.",
    expectedAvailabilityVersion: 1, idempotencyKey: key, actorId: "operator-1" }, now);
}

describe("UL-004 availability model and 3900-second gate", () => {
  it("initializes one production availability row for an active app, independent of entitlement", () => {
    expect(readAppAvailability(appId, "production", now)).toMatchObject({
      authoritativeState: "available", operationalAvailability: "available", availabilityVersion: 1,
      startBlocked: false,
    });
    expect((getDb().prepare("select count(*) count from app_launch_availability where app_id=?")
      .get(appId) as { count: number }).count).toBe(1);
  });

  it("allows equality at 3900 seconds and blocks at 3899 without client-time authority", () => {
    schedule(SAFE_START_SECONDS);
    expect(assertStartAvailability(appId, "production", now).startBlocked).toBe(false);
    expect(() => assertStartAvailability(appId, "production", new Date(now.getTime() + 1_000)))
      .toThrowError(new AppAvailabilityError("APP_MAINTENANCE_SOON"));
    const view = readAppAvailability(appId, "production", new Date(now.getTime() + 1_000));
    expect(view).toMatchObject({ operationalAvailability: "maintenance_soon", startBlocked: true,
      expectedReturnAt: new Date(now.getTime() + 5_700_000).toISOString() });
  });

  it("uses a half-open maintenance interval and stops the planned block at exact end", () => {
    const scheduled = schedule(7_200);
    const window = scheduled.windows[0];
    const during = new Date(new Date(window.startsAt).getTime() + 1);
    expect(readAppAvailability(appId, "production", during)).toMatchObject({
      operationalAvailability: "temporarily_unavailable", startBlocked: true,
    });
    expect(readAppAvailability(appId, "production", new Date(window.endsAt))).toMatchObject({
      operationalAvailability: "available", startBlocked: false,
    });
  });

  it("rejects overlaps and invalid or unsafe learner messages without changing state", () => {
    schedule(7_200);
    expect(() => scheduleMaintenanceWindow({ appId, environment: "production",
      startsAt: new Date(now.getTime() + 7_500_000), endsAt: new Date(now.getTime() + 8_000_000),
      reasonCategory: "planned", expectedAvailabilityVersion: 2, idempotencyKey: "overlap", actorId: "operator-1" }, now))
      .toThrowError(new AppAvailabilityError("MAINTENANCE_WINDOW_CONFLICT"));
    expect(() => scheduleMaintenanceWindow({ appId, environment: "production",
      startsAt: new Date(now.getTime() + 20_000_000), endsAt: new Date(now.getTime() + 21_000_000),
      reasonCategory: "planned", learnerMessage: "<script>secret token</script>", expectedAvailabilityVersion: 2,
      idempotencyKey: "unsafe", actorId: "operator-1" }, now))
      .toThrowError(new AppAvailabilityError("APP_AVAILABILITY_MESSAGE_INVALID"));
    expect(readAppAvailability(appId, "production", now).availabilityVersion).toBe(2);
  });

  it("replays exact operations once, rejects stale versions, and emits one version event", () => {
    const first = schedule(7_200, "same-key");
    const replay = scheduleMaintenanceWindow({ appId, environment: "production",
      startsAt: new Date(now.getTime() + 7_200_000), endsAt: new Date(now.getTime() + 9_000_000),
      reasonCategory: "planned_maintenance", learnerMessage: "A short planned update.",
      expectedAvailabilityVersion: 1, idempotencyKey: "same-key", actorId: "operator-1" }, now);
    expect(replay).toEqual(first);
    expect((getDb().prepare("select count(*) count from app_availability_events").get() as { count: number }).count).toBe(1);
    expect(() => transitionAvailability({ appId, environment: "production", targetState: "restoring",
      reasonCategory: "recovery", expectedAvailabilityVersion: 1, idempotencyKey: "stale", actorId: "operator-1" }, now))
      .toThrowError(new AppAvailabilityError("APP_AVAILABILITY_VERSION_CONFLICT"));
  });

  it("cancels a window explicitly and never relies on browser time to clear restoring", () => {
    const scheduled = schedule(7_200);
    const window = scheduled.windows[0];
    const cancelled = updateMaintenanceWindow({ appId, environment: "production", windowId: window.id,
      action: "cancel", expectedAvailabilityVersion: 2, expectedWindowVersion: 1,
      idempotencyKey: "cancel", actorId: "operator-1" }, now);
    expect(cancelled.windows[0].status).toBe("cancelled");
    const restoring = transitionAvailability({ appId, environment: "production", targetState: "restoring",
      reasonCategory: "deployment_recovery", expectedAvailabilityVersion: 3,
      idempotencyKey: "restore", actorId: "operator-1" }, now);
    expect(restoring).toMatchObject({ operationalAvailability: "restoring", expectedReturnAt: null, startBlocked: true });
    expect(readAppAvailability(appId, "production", new Date("2030-01-01T00:00:00Z")).operationalAvailability)
      .toBe("restoring");
  });

  it("keeps security authority separate from ordinary operations", () => {
    const blocked = setSecurityAvailability({ appId, environment: "production", blocked: true,
      expectedAvailabilityVersion: 1, sourceReference: "security-event-1", securityPrincipalId: "security-1" }, now);
    expect(blocked).toMatchObject({ operationalAvailability: "security_blocked", learnerMessage: null });
    expect(() => transitionAvailability({ appId, environment: "production", targetState: "available",
      reasonCategory: "operator", expectedAvailabilityVersion: 2, idempotencyKey: "cannot-clear", actorId: "operator-1" }, now))
      .toThrowError(new AppAvailabilityError("APP_SECURITY_BLOCKED"));
  });

  it("isolates environments", () => {
    getDb().prepare(`insert into app_launch_availability(app_id,environment,operational_state,updated_by,updated_by_type)
      values(?,'staging','temporarily_unavailable','operator','administrator')`).run(appId);
    expect(readAppAvailability(appId, "production", now).operationalAvailability).toBe("available");
    expect(readAppAvailability(appId, "staging", now).operationalAvailability).toBe("temporarily_unavailable");
  });
});
