export const PERSONAL_DATA_CATALOG_VERSION = "pc-001-v1" as const;

export type DataSubject = "parent" | "learner";
export type DataClassification = "personal" | "sensitive_personal" | "pseudonymous" | "derived";
export type DataConsumer =
  | "identity_service"
  | "learner_profile_service"
  | "app_launch_service"
  | "billing_service"
  | "billing_notification_service"
  | "analytics_service"
  | "administrator";
export type DataPurpose =
  | "parent_identity"
  | "learner_profile"
  | "learning_personalization"
  | "transactional_billing_notification"
  | "anonymous_operational_analytics";
export type ExposureSurface = "server" | "learning_app" | "log" | "telemetry" | "analytics" | "administrator";

export type ApprovedDataUse = {
  purpose: DataPurpose;
  consumers: readonly DataConsumer[];
  surfaces: readonly ExposureSurface[];
};

export type ApprovedDerivation = {
  targetKey: string;
  consumers: readonly DataConsumer[];
};

export type PersonalDataCatalogEntry = {
  key: string;
  dataElement: string;
  subject: DataSubject;
  owningRequirement: string;
  approvedUses: readonly ApprovedDataUse[];
  classification: DataClassification;
  authoritativeStore: string;
  raw: boolean;
  derivations?: readonly ApprovedDerivation[];
  learningAppExposure: "none" | "allowed";
  logging: "denied" | "allowed";
  telemetry: "denied" | "allowed";
  analytics: "denied" | "temporary_pseudonymous" | "permanent_anonymous";
  administratorAccess: "denied" | "explicit_only";
  retentionAuthority: string;
  sharingAuthority: string;
};

export const PERSONAL_DATA_CATALOG = [
  {
    key: "parent.email",
    dataElement: "parent.email",
    subject: "parent",
    owningRequirement: "IA-001",
    approvedUses: [
      { purpose: "parent_identity", consumers: ["identity_service"], surfaces: ["server"] },
      { purpose: "transactional_billing_notification", consumers: ["billing_notification_service"], surfaces: ["server"] },
    ],
    classification: "personal",
    authoritativeStore: "users.email",
    raw: true,
    learningAppExposure: "none",
    logging: "denied",
    telemetry: "denied",
    analytics: "denied",
    administratorAccess: "explicit_only",
    retentionAuthority: "PC-004",
    sharingAuthority: "PC-005",
  },
  {
    key: "learner.date_of_birth",
    dataElement: "learner.date_of_birth",
    subject: "learner",
    owningRequirement: "LP-001",
    approvedUses: [
      { purpose: "learner_profile", consumers: ["learner_profile_service"], surfaces: ["server"] },
    ],
    classification: "sensitive_personal",
    authoritativeStore: "learners.date_of_birth",
    raw: true,
    derivations: [
      { targetKey: "learner.age_derived", consumers: ["app_launch_service"] },
      { targetKey: "learner.analytics_age_band", consumers: ["analytics_service"] },
    ],
    learningAppExposure: "none",
    logging: "denied",
    telemetry: "denied",
    analytics: "denied",
    administratorAccess: "explicit_only",
    retentionAuthority: "PC-004",
    sharingAuthority: "PC-005",
  },
  {
    key: "learner.age_derived",
    dataElement: "learner.age_derived",
    subject: "learner",
    owningRequirement: "LA-001",
    approvedUses: [
      { purpose: "learning_personalization", consumers: ["app_launch_service"], surfaces: ["server", "learning_app"] },
    ],
    classification: "derived",
    authoritativeStore: "derived_at_request_time",
    raw: false,
    learningAppExposure: "allowed",
    logging: "denied",
    telemetry: "denied",
    analytics: "denied",
    administratorAccess: "denied",
    retentionAuthority: "ephemeral_app_bootstrap",
    sharingAuthority: "approved_learning_app_only",
  },
  {
    key: "learner.analytics_age_band",
    dataElement: "learner.analytics_age_band",
    subject: "learner",
    owningRequirement: "AN-001",
    approvedUses: [
      { purpose: "anonymous_operational_analytics", consumers: ["analytics_service"], surfaces: ["server", "analytics"] },
    ],
    classification: "derived",
    authoritativeStore: "analytics_daily_buffer.age_band",
    raw: false,
    learningAppExposure: "none",
    logging: "denied",
    telemetry: "denied",
    analytics: "permanent_anonymous",
    administratorAccess: "denied",
    retentionAuthority: "AN-001",
    sharingAuthority: "PC-005",
  },
  {
    key: "billing.notification_subscription_reference",
    dataElement: "billing.notification_subscription_reference",
    subject: "parent",
    owningRequirement: "BI-004",
    approvedUses: [
      {
        purpose: "transactional_billing_notification",
        consumers: ["billing_service", "billing_notification_service"],
        surfaces: ["server"],
      },
    ],
    classification: "pseudonymous",
    authoritativeStore: "billing_cancellation_notifications.subscription_id",
    raw: false,
    learningAppExposure: "none",
    logging: "denied",
    telemetry: "denied",
    analytics: "denied",
    administratorAccess: "denied",
    retentionAuthority: "BI-004",
    sharingAuthority: "PC-005",
  },
] as const satisfies readonly PersonalDataCatalogEntry[];
