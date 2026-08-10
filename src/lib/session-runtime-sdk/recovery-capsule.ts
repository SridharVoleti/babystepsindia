import { getRecoveryCapsuleRecord, putRecoveryCapsuleRecord, deleteRecoveryCapsuleRecord } from "./idb";
import { signCapsulePayload } from "./capsule";
import { claimOwnerTab } from "./ownership";
import { SessionRuntimeError, type RecoveryCapsuleRecord } from "./types";

export type SaveRecoveryCapsuleInput = {
  sessionId: string; learnerId: string; appId: string; environment: string;
  deviceSessionId: string; deploymentId: string; releaseId: string;
  stateSchemaVersion: number; baseProgressVersion: number; baseStateHash: string;
  envelopeVersion: number; hardExpiresAt: string; localRuntimeVersion: number;
  recoverySequence: number; pendingState: unknown; deviceKeyRaw: string; now: Date;
};

// PR-002 rule 18: only the owning tab may write the capsule — reuses
// SC-001's own single-owner Web Locks coordination (ownership.ts) rather
// than inventing a second lock scheme. The capsule id is minted once and
// kept stable across subsequent updates to the same session's capsule.
export async function saveRecoveryCapsule(input: SaveRecoveryCapsuleInput): Promise<RecoveryCapsuleRecord> {
  const ownership = await claimOwnerTab(input.sessionId);
  try {
    if (!ownership.isOwner) throw new SessionRuntimeError("SESSION_RUNTIME_NOT_OWNER");
    const existing = await getRecoveryCapsuleRecord(input.sessionId);
    const recoveryCapsuleId = existing?.recoveryCapsuleId ?? crypto.randomUUID();
    const recordedAt = input.now.toISOString();
    // Reuses capsule.ts's existing HMAC binding scheme (device-key-keyed,
    // never leaves this browser) as this capsule's own tamper-evidence —
    // a separate concern from the platform's server-side conflict check.
    const hmac = await signCapsulePayload(input.deviceKeyRaw, input.pendingState, input.baseProgressVersion, recordedAt);
    const record: RecoveryCapsuleRecord = {
      recoveryCapsuleId, sessionId: input.sessionId, learnerId: input.learnerId, appId: input.appId,
      environment: input.environment, deviceSessionId: input.deviceSessionId, deploymentId: input.deploymentId,
      releaseId: input.releaseId, stateSchemaVersion: input.stateSchemaVersion,
      baseProgressVersion: input.baseProgressVersion, baseStateHash: input.baseStateHash,
      envelopeVersion: input.envelopeVersion, hardExpiresAt: input.hardExpiresAt,
      localRuntimeVersion: input.localRuntimeVersion, recoverySequence: input.recoverySequence,
      pendingState: input.pendingState, recordedAt, hmac,
    };
    await putRecoveryCapsuleRecord(record);
    return record;
  } finally {
    ownership.release();
  }
}

// Rule 53: a capsule at/after its own signed hard expiry is purged locally
// and never returned/uploaded — the signed envelope's hard_expires_at is
// authoritative, never the browser's own wall clock (rule 14), but `now`
// here is still only ever used to make the *local* purge decision; the
// server independently re-checks expiry on submission regardless.
export async function loadRecoveryCapsule(sessionId: string, now: Date): Promise<RecoveryCapsuleRecord | null> {
  const record = await getRecoveryCapsuleRecord(sessionId);
  if (!record) return null;
  if (new Date(record.hardExpiresAt) <= now) {
    await deleteRecoveryCapsuleRecord(sessionId);
    return null;
  }
  return record;
}

// Rule 52: explicit purge after acknowledged recovery, finalization,
// secure exit, hard expiry or security revocation — callers invoke this
// directly in those cases rather than waiting for the next
// loadRecoveryCapsule call to lazily discover expiry.
export async function clearRecoveryCapsule(sessionId: string) {
  await deleteRecoveryCapsuleRecord(sessionId);
}
