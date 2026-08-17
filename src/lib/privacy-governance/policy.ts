import {
  PERSONAL_DATA_CATALOG,
  type DataConsumer,
  type DataPurpose,
  type ExposureSurface,
  type PersonalDataCatalogEntry,
} from "@/lib/privacy-governance/catalog";

export class PrivacyPolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PrivacyPolicyError";
  }
}

const PROHIBITED_PURPOSES = new Set([
  "advertising",
  "advertising_profile",
  "session_replay",
  "learner_surveillance",
  "behavioral_tracking",
]);

const REQUIRED_STRING_FIELDS: (keyof PersonalDataCatalogEntry)[] = [
  "key", "owningRequirement", "purpose", "classification", "authoritativeStore",
  "retentionAuthority", "sharingAuthority",
];

export function validatePersonalDataCatalog(entries: readonly PersonalDataCatalogEntry[] = PERSONAL_DATA_CATALOG) {
  const keys = new Set<string>();
  const rawAuthorities = new Map<string, string>();
  for (const entry of entries) {
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = entry[field];
      if (typeof value !== "string" || !value.trim()) throw new PrivacyPolicyError("CATALOG_ENTRY_INCOMPLETE");
    }
    if (keys.has(entry.key)) throw new PrivacyPolicyError("CATALOG_DUPLICATE_KEY");
    keys.add(entry.key);
    if (entry.allowedConsumers.length === 0) throw new PrivacyPolicyError("CATALOG_ENTRY_INCOMPLETE");
    if (entry.subject === "learner" && /email|phone|contact/i.test(entry.key)) {
      throw new PrivacyPolicyError("LEARNER_CONTACT_DATA_PROHIBITED");
    }
    if (PROHIBITED_PURPOSES.has(String(entry.purpose))) throw new PrivacyPolicyError("PURPOSE_PROHIBITED");
    if (entry.key === "learner.date_of_birth" &&
      (entry.learningAppExposure !== "none" || entry.logging !== "denied" || entry.telemetry !== "denied" ||
       entry.analytics !== "denied")) {
      throw new PrivacyPolicyError("LEARNER_DOB_EXPOSURE_PROHIBITED");
    }
    if (entry.raw) {
      const authorityKey = `${entry.subject}:${entry.key}`;
      const previous = rawAuthorities.get(authorityKey);
      if (previous && previous !== entry.authoritativeStore) {
        throw new PrivacyPolicyError("DUPLICATE_RAW_AUTHORITY_PROHIBITED");
      }
      rawAuthorities.set(authorityKey, entry.authoritativeStore);
    }
  }
  return true;
}

export function authorizePersonalDataUse(input: {
  key: string;
  purpose: DataPurpose | string;
  consumer: DataConsumer;
  surface: ExposureSurface;
}) {
  if (PROHIBITED_PURPOSES.has(input.purpose)) throw new PrivacyPolicyError("PURPOSE_PROHIBITED");
  const entry = PERSONAL_DATA_CATALOG.find((item) => item.key === input.key);
  if (!entry) throw new PrivacyPolicyError("DATA_USE_NOT_CATALOGED");
  if (entry.purpose !== input.purpose) throw new PrivacyPolicyError("PURPOSE_NOT_AUTHORIZED");
  if (!(entry.allowedConsumers as readonly string[]).includes(input.consumer)) {
    throw new PrivacyPolicyError("CONSUMER_NOT_AUTHORIZED");
  }
  if (input.surface === "learning_app" && entry.learningAppExposure !== "allowed") {
    throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  }
  if (input.surface === "log" && entry.logging !== "allowed") throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  if (input.surface === "telemetry" && entry.telemetry !== "allowed") throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  if (input.surface === "analytics" && entry.analytics === "denied") throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  if (input.surface === "administrator" && entry.administratorAccess === "denied") {
    throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  }
  return entry;
}

export function authorizeDevicePermission(permissionKey: string) {
  // PC-001 default deny. A future frozen requirement must add an explicit
  // cataloged device-permission entry before this function can return true.
  const entry = PERSONAL_DATA_CATALOG.find((item) => item.key === `device_permission.${permissionKey}`);
  if (!entry) throw new PrivacyPolicyError("DEVICE_PERMISSION_NOT_AUTHORIZED");
  return true;
}

export function isPersonalOrPseudonymous(key: string) {
  const entry = PERSONAL_DATA_CATALOG.find((item) => item.key === key);
  if (!entry) throw new PrivacyPolicyError("DATA_USE_NOT_CATALOGED");
  return entry.classification !== "derived" || entry.subject === "parent";
}
