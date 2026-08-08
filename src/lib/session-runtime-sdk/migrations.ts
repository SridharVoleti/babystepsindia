import { SessionRuntimeError } from "./types";

// GAP-082: the SDK build's own runtime-record format version. A record
// written by an older SDK is migrated forward step by step; a record
// stamped with a version newer than this build understands fails closed
// rather than being silently misread.
export const CURRENT_RUNTIME_VERSION = 1;

type Migrator = (record: Record<string, unknown>) => Record<string, unknown>;

// Keyed by the version a migrator upgrades *from*. There is no real
// pre-1 record shape in production yet (this is the first browser runtime
// build), but the mechanism itself must be real and exercised, not an
// aspirational stub — this entry proves the migration chain actually runs.
const MIGRATORS: Record<number, Migrator> = {
  0: (record) => ({
    ...record,
    runtimeVersion: 1,
    dirtySinceCheckpoint: record.dirtySinceCheckpoint ?? false,
    pendingCapsule: record.pendingCapsule ?? null,
    lastCheckpointAt: record.lastCheckpointAt ?? null,
  }),
};

export function migrateRuntimeRecord(record: Record<string, unknown>): Record<string, unknown> {
  let current = record;
  let version = Number(current.runtimeVersion ?? 0);
  if (version > CURRENT_RUNTIME_VERSION) {
    throw new SessionRuntimeError("SESSION_RUNTIME_VERSION_UNSUPPORTED");
  }
  while (version < CURRENT_RUNTIME_VERSION) {
    const migrate = MIGRATORS[version];
    if (!migrate) throw new SessionRuntimeError("SESSION_RUNTIME_VERSION_UNSUPPORTED");
    current = migrate(current);
    version = Number(current.runtimeVersion);
  }
  return current;
}
