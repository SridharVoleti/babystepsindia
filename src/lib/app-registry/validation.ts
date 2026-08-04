import { createHash } from "node:crypto";
import { appRegistryErrorStatus, AppRegistryError } from "@/lib/app-registry/errors";

export { AppRegistryError, appRegistryErrorStatus };

// Business rule 5: lowercase ASCII, hyphen separated, begins with a
// letter, 2-50 characters total.
const APP_KEY_PATTERN = /^[a-z][a-z0-9-]{1,49}$/;

export function validateAppKey(key: string): string {
  if (!APP_KEY_PATTERN.test(key)) {
    throw new AppRegistryError("APP_KEY_INVALID");
  }
  return key;
}

// Business rule 6: required, trimmed, 1-80 visible characters.
export function validateDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new AppRegistryError("APP_METADATA_INVALID");
  }
  return trimmed;
}

// Business rule 7: required before activation, plain text, 1-240 chars.
export function validateShortDescription(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 240) {
    throw new AppRegistryError("APP_METADATA_INVALID");
  }
  return trimmed;
}

// Business rule 17: mutable fields only. id/appKey/registryStatus/version/
// timestamps are immutable/system-controlled (business rule 18) and must
// be rejected outright, not silently ignored (AC27/AT-AR-001-27).
const MUTABLE_APP_FIELDS = new Set([
  "displayName",
  "shortDescription",
  "iconAssetKey",
  "category",
  "owningTeam",
  "internalNotes",
]);

// Envelope fields every mutation carries that aren't themselves app data.
const ENVELOPE_FIELDS = new Set(["expectedVersion", "idempotencyKey"]);

export function assertOnlyMutableFields(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (ENVELOPE_FIELDS.has(key)) continue;
    if (!MUTABLE_APP_FIELDS.has(key)) {
      throw new AppRegistryError("FORBIDDEN_FIELD");
    }
  }
}

// Stable regardless of key insertion order, so the same logical payload
// always hashes the same way for idempotency comparison (business rule 20).
export function computeRequestHash(payload: Record<string, unknown>): string {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    canonical[key] = payload[key];
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
