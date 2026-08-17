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

export type PersonalDataCatalogEntry = {
  key: string;
  subject: DataSubject;
  owningRequirement: string;
  purpose: DataPurpose;
  classification: DataClassification;
  authoritativeStore: string;
  raw: boolean;
  allowedConsumers: readonly DataConsumer[];
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
    subject: "parent",
    owningRequirement: "IA-001",
    purpose: "parent_identity",
    classification: "personal",
    authoritativeStore: "users.email",
    raw: true,
    allowedConsumers: ["identity_service", "billing_notification_service"],
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
    subject: "learner",
    owningRequirement: "LP-001",
    purpose: "learner_profile",
    classification: "sensitive_personal",
    authoritativeStore: "learners.date_of_birth",
    raw: true,
    allowedConsumers: ["learner_profile_service", "app_launch_service", "analytics_service"],
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
    subject: "learner",
    owningRequirement: "LA-001",
    purpose: "learning_personalization",
    classification: "derived",
    authoritativeStore: "derived_at_request_time",
    raw: false,
    allowedConsumers: ["app_launch_service"],
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
    subject: "learner",
    owningRequirement: "AN-001",
    purpose: "anonymous_operational_analytics",
    classification: "derived",
    authoritativeStore: "analytics_daily_buffer.age_band",
    raw: false,
    allowedConsumers: ["analytics_service"],
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
    subject: "parent",
    owningRequirement: "BI-004",
    purpose: "transactional_billing_notification",
    classification: "pseudonymous",
    authoritativeStore: "billing_cancellation_notifications.subscription_id",
    raw: false,
    allowedConsumers: ["billing_service", "billing_notification_service"],
    learningAppExposure: "none",
    logging: "denied",
    telemetry: "denied",
    analytics: "denied",
    administratorAccess: "denied",
    retentionAuthority: "BI-004",
    sharingAuthority: "PC-005",
  },
] as const satisfies readonly PersonalDataCatalogEntry[];
