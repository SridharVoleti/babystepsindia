// @vitest-environment node
import "fake-indexeddb/auto";
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueSessionEnvelope } from "@/lib/session-runtime/envelope";
import {
  checkpointIfDue,
  claimOwnerTab,
  clearRuntime,
  createRuntime,
  prepareResume,
  recordMeaningfulChange,
  SessionRuntimeError,
} from "@/lib/session-runtime-sdk";
import { getRuntimeRecord, putRuntimeRecord } from "@/lib/session-runtime-sdk/idb";
import { migrateRuntimeRecord } from "@/lib/session-runtime-sdk/migrations";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const expected = { appId: "app-1", deploymentId: "deployment-1", releaseId: "release-1" };

function envelopeClaims(overrides: Partial<Parameters<typeof issueSessionEnvelope>[0]> = {}) {
  return {
    learner_session_id: "session-1", learner_id: "learner-1", app_id: "app-1",
    environment: "production", deployment_id: "deployment-1", release_id: "release-1",
    device_session_id: "device-1", usable_launch_established_at: "2026-08-09T10:00:00.000Z",
    hard_expires_at: "2026-08-09T11:00:00.000Z", maximum_connected_seconds: 2700,
    ...overrides,
  };
}

async function freshDb() {
  // fake-indexeddb keeps a single shared in-memory database across tests
  // unless explicitly reset; each test gets an isolated database name via
  // deleting any leftover databases before it runs.
  const databases = await indexedDB.databases();
  await Promise.all(databases.map((info) => new Promise<void>((resolve) => {
    if (!info.name) return resolve();
    const request = indexedDB.deleteDatabase(info.name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  })));
}

beforeEach(async () => { await freshDb(); });

describe("SC-001 browser runtime SDK", () => {
  it("createRuntime verifies the envelope client-side before persisting anything", async () => {
    const now = new Date("2026-08-09T10:00:01.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    const record = await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    expect(record).toMatchObject({ sessionId: "session-1", learnerId: "learner-1", appId: "app-1", dirtySinceCheckpoint: false });
    expect(await getRuntimeRecord("session-1")).toMatchObject({ sessionId: "session-1" });
  });

  it("rejects an envelope that fails verification and persists nothing", async () => {
    const now = new Date("2026-08-09T10:00:01.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await expect(createRuntime({ sessionEnvelope: envelope,
      envelopePublicKeyPem: publicKeyPem, expected: { ...expected, appId: "wrong-app" }, now })).rejects.toThrow();
    expect(await getRuntimeRecord("session-1")).toBeUndefined();
  });

  it("recordMeaningfulChange writes only to IndexedDB — checkpointIfDue never syncs early or when nothing changed", async () => {
    const now = new Date("2026-08-09T10:00:01.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    const syncFn = vi.fn(async () => {});

    // No meaningful change yet — must not sync even though "due" by clock.
    expect(await checkpointIfDue("session-1", new Date(now.getTime() + 6 * 60_000), syncFn)).toEqual({ synced: false });
    expect(syncFn).not.toHaveBeenCalled();

    await recordMeaningfulChange("session-1", { level: 3 }, new Date(now.getTime() + 30_000), 1);
    // Dirty, but not yet 5 minutes since last checkpoint (session start) — must not sync.
    expect(await checkpointIfDue("session-1", new Date(now.getTime() + 60_000), syncFn)).toEqual({ synced: false });
    expect(syncFn).not.toHaveBeenCalled();

    // Now due and dirty — syncs exactly once.
    const dueAt = new Date(now.getTime() + 5 * 60_000 + 1_000);
    expect(await checkpointIfDue("session-1", dueAt, syncFn)).toEqual({ synced: true });
    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncFn).toHaveBeenCalledWith({ level: 3 });

    // Immediately after: no longer dirty, so no repeat sync even though still "due" by clock.
    expect(await checkpointIfDue("session-1", new Date(dueAt.getTime() + 1_000), syncFn)).toEqual({ synced: false });
    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("proves zero periodic network calls over a long span with only occasional meaningful writes (GAP-083)", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims({ hard_expires_at: "2026-08-09T11:00:00.000Z" }), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    const syncFn = vi.fn(async () => {});

    // Simulate a 45-minute session: a tick every 10 seconds (270 ticks —
    // far more frequent than any real heartbeat would be), with a
    // meaningful change recorded only three times total.
    let meaningfulWritesLeft = 3;
    for (let elapsedMs = 0; elapsedMs <= 45 * 60_000; elapsedMs += 10_000) {
      const tick = new Date(now.getTime() + elapsedMs);
      if (meaningfulWritesLeft > 0 && elapsedMs % (12 * 60_000) === 0 && elapsedMs > 0) {
        await recordMeaningfulChange("session-1", { tick: elapsedMs }, tick, 1);
        meaningfulWritesLeft--;
      }
      await checkpointIfDue("session-1", tick, syncFn);
    }
    // Three meaningful changes, each separated by >=5 minutes, can produce
    // at most three syncs — never one per tick.
    expect(syncFn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(syncFn.mock.calls.length).toBeGreaterThan(0);
  });

  it("retries a checkpoint whose sync failed, keeping the capsule until it succeeds", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    await recordMeaningfulChange("session-1", { level: 1 }, now, 1);
    const dueAt = new Date(now.getTime() + 6 * 60_000);
    await expect(checkpointIfDue("session-1", dueAt, async () => { throw new Error("network down"); })).rejects.toThrow("network down");
    const record = await getRuntimeRecord("session-1");
    expect(record?.dirtySinceCheckpoint).toBe(true);
    expect(record?.pendingCapsule).not.toBeNull();
  });

  it("recovers a pending capsule exactly once when the server version still matches (GAP-055/081)", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    await recordMeaningfulChange("session-1", { level: 5 }, now, 1);

    const first = await prepareResume("session-1", new Date(now.getTime() + 60_000), 1);
    expect(first.recoveredPayload).toEqual({ level: 5 });

    const second = await prepareResume("session-1", new Date(now.getTime() + 120_000), 1);
    expect(second.recoveredPayload).toBeNull();
  });

  it("discards a capsule once the server has already moved past its version", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    await recordMeaningfulChange("session-1", { level: 5 }, now, 1);

    const resumed = await prepareResume("session-1", new Date(now.getTime() + 60_000), 2);
    expect(resumed.recoveredPayload).toBeNull();
  });

  it("discards a capsule past the session's hard expiry", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims({ hard_expires_at: "2026-08-09T10:05:00.000Z" }), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    await recordMeaningfulChange("session-1", { level: 5 }, now, 1);

    const resumed = await prepareResume("session-1", new Date("2026-08-09T10:06:00.000Z"), 1);
    expect(resumed.recoveredPayload).toBeNull();
  });

  it("migrates a legacy runtime record forward instead of crashing on missing fields", () => {
    const legacy = { runtimeVersion: 0, sessionId: "session-1", learnerId: "learner-1" };
    const migrated = migrateRuntimeRecord(legacy) as { runtimeVersion: number; dirtySinceCheckpoint: boolean; pendingCapsule: unknown };
    expect(migrated.runtimeVersion).toBe(1);
    expect(migrated.dirtySinceCheckpoint).toBe(false);
    expect(migrated.pendingCapsule).toBeNull();
  });

  it("fails closed on a runtime record newer than this SDK build understands", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    const existing = await getRuntimeRecord("session-1");
    await putRuntimeRecord({ ...existing!, runtimeVersion: 99 });

    const laterEnvelope = await issueSessionEnvelope(envelopeClaims(), new Date(now.getTime() + 1000), privateKeyPem);
    await expect(createRuntime({ sessionEnvelope: laterEnvelope, envelopePublicKeyPem: publicKeyPem, expected,
      now: new Date(now.getTime() + 1000) })).rejects.toEqual(new SessionRuntimeError("SESSION_RUNTIME_VERSION_UNSUPPORTED"));
  });

  it("clearRuntime removes the local record entirely", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const envelope = await issueSessionEnvelope(envelopeClaims(), now, privateKeyPem);
    await createRuntime({ sessionEnvelope: envelope, envelopePublicKeyPem: publicKeyPem, expected, now });
    await clearRuntime("session-1");
    expect(await getRuntimeRecord("session-1")).toBeUndefined();
  });

  it("degrades to sole-owner when the browser has no Web Locks support at all", async () => {
    const first = await claimOwnerTab("session-owner-degraded");
    expect(first.isOwner).toBe(true);
    first.release();
  });

  it("grants exactly one owner tab per session and hands off coordination on release (Web Locks mocked)", async () => {
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
      const first = await claimOwnerTab("session-owner-mocked");
      expect(first.isOwner).toBe(true);

      const second = await claimOwnerTab("session-owner-mocked");
      expect(second.isOwner).toBe(false);

      first.release();
      await Promise.resolve(); // let the lock-manager's release microtask settle

      const third = await claimOwnerTab("session-owner-mocked");
      expect(third.isOwner).toBe(true);
      third.release();
      second.release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
