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
  "key", "dataElement", "owningRequirement", "classification", "authoritativeStore",
  "retentionAuthority", "sharingAuthority",
];

function surfaceGloballyAllowed(entry: PersonalDataCatalogEntry, surface: ExposureSurface) {
  if (surface === "learning_app") return entry.learningAppExposure === "allowed";
  if (surface === "log") return entry.logging === "allowed";
  if (surface === "telemetry") return entry.telemetry === "allowed";
  if (surface === "analytics") return entry.analytics !== "denied";
  if (surface === "administrator") return entry.administratorAccess !== "denied";
  return true;
}

export function validatePersonalDataCatalog(entries: readonly PersonalDataCatalogEntry[] = PERSONAL_DATA_CATALOG) {
  const keys = new Set<string>();
  const rawAuthorities = new Map<string, string>();
  const catalogKeys = new Set(entries.map((entry) => entry.key));

  for (const entry of entries) {
    for (const field of REQUIRED_STRING_FIELDS) {
      const value = entry[field];
      if (typeof value !== "string" || !value.trim()) throw new PrivacyPolicyError("CATALOG_ENTRY_INCOMPLETE");
    }
    if (keys.has(entry.key)) throw new PrivacyPolicyError("CATALOG_DUPLICATE_KEY");
    keys.add(entry.key);
    if (entry.approvedUses.length === 0) throw new PrivacyPolicyError("CATALOG_ENTRY_INCOMPLETE");
    if (entry.subject === "learner" && /email|phone|contact/i.test(entry.dataElement)) {
      throw new PrivacyPolicyError("LEARNER_CONTACT_DATA_PROHIBITED");
    }

    for (const use of entry.approvedUses) {
      if (!use.purpose || use.consumers.length === 0 || use.surfaces.length === 0) {
        throw new PrivacyPolicyError("CATALOG_ENTRY_INCOMPLETE");
      }
      if (PROHIBITED_PURPOSES.has(String(use.purpose))) throw new PrivacyPolicyError("PURPOSE_PROHIBITED");
      for (const surface of use.surfaces) {
        if (!surfaceGloballyAllowed(entry, surface)) throw new PrivacyPolicyError("CATALOG_SURFACE_CONFLICT");
      }
    }

    if (entry.key === "learner.date_of_birth" &&
      (entry.learningAppExposure !== "none" || entry.logging !== "denied" || entry.telemetry !== "denied" ||
       entry.analytics !== "denied")) {
      throw new PrivacyPolicyError("LEARNER_DOB_EXPOSURE_PROHIBITED");
    }

    for (const derivation of entry.derivations ?? []) {
      if (!catalogKeys.has(derivation.targetKey) || derivation.consumers.length === 0) {
        throw new PrivacyPolicyError("CATALOG_DERIVATION_INVALID");
      }
      const target = entries.find((candidate) => candidate.key === derivation.targetKey)!;
      if (target.raw || target.subject !== entry.subject) throw new PrivacyPolicyError("CATALOG_DERIVATION_INVALID");
    }

    if (entry.raw) {
      const authorityKey = `${entry.subject}:${entry.dataElement}`;
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
  const purposeUses = entry.approvedUses.filter((use) => use.purpose === input.purpose);
  if (purposeUses.length === 0) throw new PrivacyPolicyError("PURPOSE_NOT_AUTHORIZED");
  const consumerUses = purposeUses.filter((use) => (use.consumers as readonly string[]).includes(input.consumer));
  if (consumerUses.length === 0) throw new PrivacyPolicyError("CONSUMER_NOT_AUTHORIZED");
  if (!surfaceGloballyAllowed(entry, input.surface) ||
      !consumerUses.some((use) => (use.surfaces as readonly string[]).includes(input.surface))) {
    throw new PrivacyPolicyError("SURFACE_NOT_AUTHORIZED");
  }
  return entry;
}

export function authorizePersonalDataDerivation(input: {
  sourceKey: string;
  targetKey: string;
  consumer: DataConsumer;
}) {
  const source = PERSONAL_DATA_CATALOG.find((entry) => entry.key === input.sourceKey);
  const target = PERSONAL_DATA_CATALOG.find((entry) => entry.key === input.targetKey);
  if (!source || !target) throw new PrivacyPolicyError("DATA_USE_NOT_CATALOGED");
  const derivation = source.derivations?.find((candidate) => candidate.targetKey === input.targetKey);
  if (!derivation || !(derivation.consumers as readonly string[]).includes(input.consumer)) {
    throw new PrivacyPolicyError("DERIVATION_NOT_AUTHORIZED");
  }
  if (target.raw || source.subject !== target.subject) throw new PrivacyPolicyError("DERIVATION_NOT_AUTHORIZED");
  return { source, target };
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
  return entry.classification === "personal" || entry.classification === "sensitive_personal" ||
    entry.classification === "pseudonymous";
}
