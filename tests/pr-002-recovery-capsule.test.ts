// @vitest-environment node
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRecoveryCapsule,
  loadRecoveryCapsule,
  saveRecoveryCapsule,
  SessionRuntimeError,
  type SaveRecoveryCapsuleInput,
} from "@/lib/session-runtime-sdk";
import { getRecoveryCapsuleRecord, getRuntimeRecord, putRuntimeRecord } from "@/lib/session-runtime-sdk/idb";

async function freshDb() {
  const databases = await indexedDB.databases();
  await Promise.all(databases.map((info) => new Promise<void>((resolve) => {
    if (!info.name) return resolve();
    const request = indexedDB.deleteDatabase(info.name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  })));
}

beforeEach(async () => { await freshDb(); });

function capsuleInput(overrides: Partial<SaveRecoveryCapsuleInput> = {}): SaveRecoveryCapsuleInput {
  return {
    sessionId: "session-1", learnerId: "learner-1", appId: "app-1", environment: "production",
    deviceSessionId: "device-1", deploymentId: "deployment-1", releaseId: "release-1",
    stateSchemaVersion: 1, baseProgressVersion: 3, baseStateHash: "hash-3",
    envelopeVersion: 1, hardExpiresAt: "2026-08-09T11:00:00.000Z", localRuntimeVersion: 1,
    recoverySequence: 1, pendingState: { level: 4 }, deviceKeyRaw: "aa".repeat(32),
    now: new Date("2026-08-09T10:00:00.000Z"),
    ...overrides,
  };
}

describe("PR-002 recovery capsule", () => {
  it("saves a capsule bound to the exact session/learner/app/device/release/schema", async () => {
    const record = await saveRecoveryCapsule(capsuleInput());
    expect(record).toMatchObject({
      sessionId: "session-1", learnerId: "learner-1", appId: "app-1", deviceSessionId: "device-1",
      deploymentId: "deployment-1", releaseId: "release-1", stateSchemaVersion: 1,
      baseProgressVersion: 3, baseStateHash: "hash-3", recoverySequence: 1, pendingState: { level: 4 },
    });
    expect(record.recoveryCapsuleId).toBeTruthy();
    expect(record.hmac).toBeTruthy();
  });

  it("keeps at most one capsule per session — a second save overwrites, not appends", async () => {
    const first = await saveRecoveryCapsule(capsuleInput());
    const second = await saveRecoveryCapsule(capsuleInput({ recoverySequence: 2, pendingState: { level: 5 } }));
    expect(second.recoveryCapsuleId).toBe(first.recoveryCapsuleId);
    const loaded = await loadRecoveryCapsule("session-1", new Date("2026-08-09T10:05:00.000Z"));
    expect(loaded?.pendingState).toEqual({ level: 5 });
    expect(loaded?.recoverySequence).toBe(2);
  });

  it("loadRecoveryCapsule returns null and purges once past the signed hard expiry (rule 53)", async () => {
    await saveRecoveryCapsule(capsuleInput({ hardExpiresAt: "2026-08-09T10:05:00.000Z" }));
    const stillLive = await loadRecoveryCapsule("session-1", new Date("2026-08-09T10:04:59.000Z"));
    expect(stillLive).not.toBeNull();
    const expired = await loadRecoveryCapsule("session-1", new Date("2026-08-09T10:05:00.000Z"));
    expect(expired).toBeNull();
    expect(await getRecoveryCapsuleRecord("session-1")).toBeUndefined();
  });

  it("loadRecoveryCapsule returns null when no capsule exists for the session", async () => {
    expect(await loadRecoveryCapsule("no-such-session", new Date())).toBeNull();
  });

  it("clearRecoveryCapsule explicitly purges (rule 52)", async () => {
    await saveRecoveryCapsule(capsuleInput());
    await clearRecoveryCapsule("session-1");
    expect(await getRecoveryCapsuleRecord("session-1")).toBeUndefined();
  });

  it("does not disturb the unrelated SC-001 runtimes store (separate object stores)", async () => {
    await putRuntimeRecord({
      runtimeVersion: 1, sessionId: "session-1", learnerId: "learner-1", appId: "app-1", environment: "production",
      deploymentId: "deployment-1", releaseId: "release-1", deviceSessionId: "device-1",
      usableLaunchEstablishedAt: "2026-08-09T10:00:00.000Z", hardExpiresAt: "2026-08-09T11:00:00.000Z",
      maximumConnectedSeconds: 2700, deviceKeyRaw: "bb".repeat(32), createdAt: "2026-08-09T10:00:00.000Z",
      lastCheckpointAt: null, dirtySinceCheckpoint: false, pendingCapsule: null,
    });
    await saveRecoveryCapsule(capsuleInput());
    await clearRecoveryCapsule("session-1");
    expect(await getRuntimeRecord("session-1")).toMatchObject({ sessionId: "session-1" });
  });

  it("rejects a write from a non-owner tab (rule 18)", async () => {
    type LockCallback = (lock: { name: string } | null) => Promise<void>;
    const held = new Set<string>();
    const fakeLocks = {
      request: (name: string, options: { ifAvailable?: boolean }, callback: LockCallback) => {
        if (held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        const holdPromise = callback({ name });
        void holdPromise.then(() => held.delete(name));
        return holdPromise;
      },
    };
    vi.stubGlobal("navigator", { locks: fakeLocks });
    try {
      const { claimOwnerTab } = await import("@/lib/session-runtime-sdk");
      // Hold the owner lock open so a second saveRecoveryCapsule call can't acquire it.
      const owner = await claimOwnerTab("session-1");
      await expect(saveRecoveryCapsule(capsuleInput())).rejects.toEqual(new SessionRuntimeError("SESSION_RUNTIME_NOT_OWNER"));
      owner.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
