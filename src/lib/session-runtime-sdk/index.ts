import { verifySessionEnvelope } from "@/lib/session-runtime/envelope";
import { deleteRuntimeRecord, getRuntimeRecord, putRuntimeRecord } from "./idb";
import { CURRENT_RUNTIME_VERSION, migrateRuntimeRecord } from "./migrations";
import { randomDeviceKey, signCapsulePayload, verifyCapsulePayload } from "./capsule";
import { SessionRuntimeError, type CreateRuntimeInput, type RuntimeRecord } from "./types";

export { claimOwnerTab, channelName, type TabOwnership, type OwnerBroadcastMessage } from "./ownership";
export { SessionRuntimeError, type RuntimeRecord, type CreateRuntimeInput, type RecoveryCapsuleRecord } from "./types";
export { saveRecoveryCapsule, loadRecoveryCapsule, clearRecoveryCapsule, type SaveRecoveryCapsuleInput } from "./recovery-capsule";

const CHECKPOINT_INTERVAL_MS = 5 * 60_000;

// GAP-077/078: real IndexedDB persistence keyed off a browser-verified
// (public-key, GAP-078) session envelope — the runtime record only ever
// comes into existence once the envelope itself checks out.
export async function createRuntime(input: CreateRuntimeInput): Promise<RuntimeRecord> {
  const claims = await verifySessionEnvelope(input.sessionEnvelope, input.expected, input.now, input.envelopePublicKeyPem);
  const existingRaw = await getRuntimeRecord(claims.learner_session_id);
  const existing = existingRaw ? (migrateRuntimeRecord(existingRaw as unknown as Record<string, unknown>) as unknown as RuntimeRecord) : undefined;
  const stillLive = existing && new Date(existing.hardExpiresAt) > input.now;
  const record: RuntimeRecord = {
    runtimeVersion: CURRENT_RUNTIME_VERSION,
    sessionId: claims.learner_session_id,
    learnerId: claims.learner_id,
    appId: claims.app_id,
    environment: claims.environment,
    deploymentId: claims.deployment_id,
    releaseId: claims.release_id,
    deviceSessionId: claims.device_session_id,
    usableLaunchEstablishedAt: claims.usable_launch_established_at,
    hardExpiresAt: claims.hard_expires_at,
    maximumConnectedSeconds: claims.maximum_connected_seconds,
    deviceKeyRaw: stillLive ? existing!.deviceKeyRaw : randomDeviceKey(),
    createdAt: stillLive ? existing!.createdAt : input.now.toISOString(),
    lastCheckpointAt: stillLive ? existing!.lastCheckpointAt : null,
    dirtySinceCheckpoint: stillLive ? existing!.dirtySinceCheckpoint : false,
    pendingCapsule: stillLive ? existing!.pendingCapsule : null,
  };
  await putRuntimeRecord(record);
  return record;
}

function requireRecord(record: RuntimeRecord | undefined): RuntimeRecord {
  if (!record) throw new SessionRuntimeError("SESSION_RUNTIME_NOT_FOUND");
  return record;
}

// GAP-057/083: a meaningful change is staged to IndexedDB only — no
// platform network call happens here. Ordinary interaction (question
// clicks, navigation) that the caller doesn't consider meaningful never
// reaches this function at all, so it never triggers a write either.
export async function recordMeaningfulChange(sessionId: string, payload: unknown, now: Date, serverProgressVersion: number) {
  const record = requireRecord(await getRuntimeRecord(sessionId));
  const recordedAt = now.toISOString();
  const hmac = await signCapsulePayload(record.deviceKeyRaw, payload, serverProgressVersion, recordedAt);
  const updated: RuntimeRecord = {
    ...record, dirtySinceCheckpoint: true,
    pendingCapsule: { payload, serverProgressVersion, recordedAt, hmac },
  };
  await putRuntimeRecord(updated);
}

// GAP-022/057: the only place a network/platform-DB write can be triggered
// from — and only when both a meaningful change is pending *and* at least
// five minutes have elapsed since the last checkpoint. Every other call
// site in this SDK is purely local (IndexedDB).
export async function checkpointIfDue(sessionId: string, now: Date,
  syncFn: (payload: unknown) => Promise<void>): Promise<{ synced: boolean }> {
  const record = requireRecord(await getRuntimeRecord(sessionId));
  if (!record.dirtySinceCheckpoint || !record.pendingCapsule) return { synced: false };
  // The checkpoint clock is anchored to the last successful checkpoint, or
  // session start if there hasn't been one yet — never "immediately due"
  // just because no checkpoint has happened yet.
  const anchor = new Date(record.lastCheckpointAt ?? record.createdAt).getTime();
  const due = now.getTime() - anchor >= CHECKPOINT_INTERVAL_MS;
  if (!due) return { synced: false };
  await syncFn(record.pendingCapsule.payload);
  await putRuntimeRecord({ ...record, dirtySinceCheckpoint: false, pendingCapsule: null, lastCheckpointAt: now.toISOString() });
  return { synced: true };
}

// GAP-055/081: one-time, bounded recovery of a capsule this device wrote
// but never confirmed the server received — never returned twice, never
// returned once it's stale (hard-expired) or the server has already moved
// past the version it was captured against.
export async function prepareResume(sessionId: string, now: Date, serverProgressVersion: number): Promise<{
  record: RuntimeRecord; recoveredPayload: unknown | null;
}> {
  const record = requireRecord(await getRuntimeRecord(sessionId));
  const capsule = record.pendingCapsule;
  if (!capsule) return { record, recoveredPayload: null };
  const hardExpired = new Date(record.hardExpiresAt) <= now;
  const versionMatches = capsule.serverProgressVersion === serverProgressVersion;
  const integrityOk = !hardExpired && versionMatches &&
    await verifyCapsulePayload(record.deviceKeyRaw, capsule.payload, capsule.serverProgressVersion, capsule.recordedAt, capsule.hmac);
  const updated: RuntimeRecord = { ...record, pendingCapsule: null,
    dirtySinceCheckpoint: integrityOk ? record.dirtySinceCheckpoint : false };
  await putRuntimeRecord(updated);
  return { record: updated, recoveredPayload: integrityOk ? capsule.payload : null };
}

export async function clearRuntime(sessionId: string) {
  await deleteRuntimeRecord(sessionId);
}
