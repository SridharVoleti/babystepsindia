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
