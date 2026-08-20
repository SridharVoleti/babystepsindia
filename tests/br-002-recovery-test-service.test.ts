// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
import {
  DisasterRecoveryError, getRecoveryTestRecord, listRecoveryTestRecords, startRecoveryTestRecord, updateRecoveryTestRecord,
} from "@/lib/disaster-recovery/service";

let ADMIN: string;

beforeEach(() => {
  useInMemoryDb();
  ADMIN = ensureBootstrapPlatformAdmin();
});

describe("BR-002 startRecoveryTestRecord", () => {
  it("starts a new evidence record with the initiating staff account and outbound-suppression flag", async () => {
    const record = await startRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { backupReference: "2026-08-16-daily", tempProjectReference: "temp-drill-2026-08", outboundProcessingSuppressed: true, idempotencyKey: "k-1" },
    );
    expect(record.backupReference).toBe("2026-08-16-daily");
    expect(record.outboundProcessingSuppressed).toBe(true);
    expect(record.deletionReplayConfirmed).toBe(false);
    expect(record.completedAt).toBeNull();
    expect(await getRecoveryTestRecord(record.id)).toMatchObject({ id: record.id });
  });

  it("rejects an empty backup or temp-project reference", async () => {
    await expect(startRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { backupReference: "  ", tempProjectReference: "temp-1", outboundProcessingSuppressed: true, idempotencyKey: "k-2" },
    )).rejects.toThrow(DisasterRecoveryError);
  });

  it("replaying the same idempotencyKey returns the same record rather than creating a second one", async () => {
    const first = await startRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { backupReference: "b-1", tempProjectReference: "t-1", outboundProcessingSuppressed: true, idempotencyKey: "k-3" },
    );
    const second = await startRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { backupReference: "b-1", tempProjectReference: "t-1", outboundProcessingSuppressed: true, idempotencyKey: "k-3" },
    );
    expect(second.id).toBe(first.id);
    expect(await listRecoveryTestRecords()).toHaveLength(1);
  });
});

describe("BR-002 updateRecoveryTestRecord", () => {
  async function startRecord(key: string) {
    return startRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { backupReference: "b-1", tempProjectReference: "t-1", outboundProcessingSuppressed: true, idempotencyKey: key },
    );
  }

  it("records a single step's confirmation and notes without touching the others", async () => {
    const record = await startRecord("u-1");
    const updated = await updateRecoveryTestRecord(
      { staffAccountId: ADMIN },
      { recordId: record.id, deletionReplay: { confirmed: true, notes: "0 rows resurrected" }, idempotencyKey: "u-1-step" },
    );
    expect(updated.deletionReplayConfirmed).toBe(true);
    expect(updated.deletionReplayNotes).toBe("0 rows resurrected");
    expect(updated.billingReconciliationConfirmed).toBe(false);
    expect(updated.completedAt).toBeNull();
  });

  it("sets completedAt only once all 4 validation steps are confirmed", async () => {
    const record = await startRecord("u-2");
    await updateRecoveryTestRecord({ staffAccountId: ADMIN }, { recordId: record.id, deletionReplay: { confirmed: true }, idempotencyKey: "u-2-a" });
    await updateRecoveryTestRecord({ staffAccountId: ADMIN }, { recordId: record.id, billingReconciliation: { confirmed: true }, idempotencyKey: "u-2-b" });
    await updateRecoveryTestRecord({ staffAccountId: ADMIN }, { recordId: record.id, derivableStateRebuild: { confirmed: true }, idempotencyKey: "u-2-c" });
    let latest = (await getRecoveryTestRecord(record.id))!;
    expect(latest.completedAt).toBeNull();
    const finalUpdate = await updateRecoveryTestRecord(
      { staffAccountId: ADMIN }, { recordId: record.id, criticalFlows: { confirmed: true }, idempotencyKey: "u-2-d" },
    );
    expect(finalUpdate.completedAt).not.toBeNull();
  });

  it("teardown is recorded independently of validation completion", async () => {
    const record = await startRecord("u-3");
    const updated = await updateRecoveryTestRecord(
      { staffAccountId: ADMIN }, { recordId: record.id, teardownConfirmed: true, idempotencyKey: "u-3-teardown" },
    );
    expect(updated.teardownConfirmedAt).not.toBeNull();
    expect(updated.completedAt).toBeNull();
  });

  it("throws RECORD_NOT_FOUND for an unknown record id", async () => {
    await expect(updateRecoveryTestRecord(
      { staffAccountId: ADMIN }, { recordId: "does-not-exist", teardownConfirmed: true, idempotencyKey: "u-4" },
    )).rejects.toThrow(DisasterRecoveryError);
  });

  it("never mutates a source-of-truth table — only its own record", async () => {
    const record = await startRecord("u-5");
    const before = getDb().prepare("select count(*) n from staff_accounts").get();
    await updateRecoveryTestRecord({ staffAccountId: ADMIN }, { recordId: record.id, deletionReplay: { confirmed: true }, idempotencyKey: "u-5-step" });
    expect(getDb().prepare("select count(*) n from staff_accounts").get()).toEqual(before);
  });
});
