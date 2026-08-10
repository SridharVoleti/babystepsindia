export type RuntimeRecord = {
  runtimeVersion: number;
  sessionId: string;
  learnerId: string;
  appId: string;
  environment: string;
  deploymentId: string;
  releaseId: string;
  deviceSessionId: string;
  usableLaunchEstablishedAt: string;
  hardExpiresAt: string;
  maximumConnectedSeconds: number;
  // Never leaves this device/IndexedDB — used only to bind a pending
  // capsule to this specific runtime instance (GAP-081).
  deviceKeyRaw: string;
  createdAt: string;
  lastCheckpointAt: string | null;
  dirtySinceCheckpoint: boolean;
  pendingCapsule: PendingCapsule | null;
};

export type PendingCapsule = {
  payload: unknown;
  serverProgressVersion: number;
  recordedAt: string;
  hmac: string;
};

export type CreateRuntimeInput = {
  sessionEnvelope: string;
  envelopePublicKeyPem: string;
  expected: { appId: string; deploymentId: string; releaseId: string };
  now: Date;
};

export class SessionRuntimeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SessionRuntimeError"; }
}

// PR-002: a separate, independently-surviving record from RuntimeRecord's
// own embedded `pendingCapsule` — that field is discarded by prepareResume
// the instant hard expiry passes (SC-001's own same-tab-crash recovery);
// this one must survive right up to (and be purged exactly at) that same
// boundary, submitted through a server endpoint instead of consumed
// locally. Rule 4-9: at most one per session, bound to the exact
// session/learner/app/device/deployment/release/schema, no credentials or
// other-learner data (enforcement of that is primarily server-side, via
// LA-003's own content validation on submission).
export type RecoveryCapsuleRecord = {
  recoveryCapsuleId: string;
  sessionId: string;
  learnerId: string;
  appId: string;
  environment: string;
  deviceSessionId: string;
  deploymentId: string;
  releaseId: string;
  stateSchemaVersion: number;
  baseProgressVersion: number;
  baseStateHash: string;
  envelopeVersion: number;
  hardExpiresAt: string;
  localRuntimeVersion: number;
  recoverySequence: number;
  pendingState: unknown;
  recordedAt: string;
  hmac: string;
};
