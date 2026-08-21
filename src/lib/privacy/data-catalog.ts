// PC-001: the canonical Data Catalog and classification gate. This module
// is the single source of truth for "what personal data does this
// platform hold, and why" — every table in src/lib/db/schema.sql must
// have an entry here, and tests/pc-001-data-catalog.test.ts fails closed
// (build-time, not just documentation) if a table's live columns would
// classify it differently than what's declared below, or if a new table
// has no entry at all. Table-level classification for all tables;
// field-level purpose/requirement traceability only for the small set of
// tables that actually carry a direct personal identifier (rule: "every
// approved personal-data field/exposure maps to purpose + frozen
// requirement" — the field catalog below is that mapping).

export type PersonalDataTier =
  // No column here references a specific person at all — pure catalog/
  // system/job-run/audit-metadata content.
  | "no_personal_data"
  // References a specific person via an opaque foreign key (learner_id,
  // parent/user_id, staff_account_id, admin_id) but stores no raw
  // identifying attribute of that person directly — the desired default
  // shape for the large majority of tables in this schema.
  | "pseudonymous_derived"
  // Stores a raw identifying attribute of an adult (parent or staff)
  // directly: email, phone, display name, password hash.
  | "direct_identifier"
  // Stores a raw identifying attribute of a LEARNER (a child) directly —
  // its own tier because PC-001 singles this out explicitly ("no learner
  // contact identity"). Note the platform already keeps learners contact-
  // identity-free by design: no email/phone column exists on `learners`
  // at all, only display_name/date_of_birth.
  | "restricted_child_data";

// Column names that make a table `direct_identifier`/`restricted_child_data`
// the moment they appear — used by both the static catalog below and the
// live schema-driven classifier in the test, so "what counts as an
// identifier" is defined exactly once.
export const IDENTIFIER_COLUMN_NAMES = new Set([
  "email", "normalized_email", "old_email", "new_email", "recipient_email",
  "phone_e164", "phone_country_code",
  "display_name", "normalized_display_name",
  "password_hash",
  "date_of_birth",
]);

// `display_name`/`normalized_display_name` are ambiguous by column name
// alone — the same names are used for a non-person entity's own name
// (an app's display name in the registry, never a person's). Listed
// explicitly, with why, rather than silently loosening the identifier-name
// match for everyone.
export const AMBIGUOUS_IDENTIFIER_EXEMPTIONS = new Set([
  "app_registry.display_name",
]);

// Column-name substrings that must never appear anywhere in the schema —
// PC-001's explicit prohibited list (advertising identifiers, behavioral
// profiling, session replay, unnecessary device fingerprinting). Checked
// against every live column in the enforcement test, not just these
// declared tables, so a new table can't quietly reintroduce one.
export const PROHIBITED_COLUMN_PATTERNS = [
  /advertising_?id/i, /\bad_id\b/i, /session_?replay/i, /behavio?ral_?profile/i,
  /device_?fingerprint/i, /tracking_?id/i, /\bidfa\b/i, /\bgaid\b/i,
];

export const RETIRED_TABLES = new Set(["admin_permissions", "consent_acceptances"]);

export const TABLE_PERSONAL_DATA_CLASSIFICATION: Record<string, PersonalDataTier> = {
  account_events: "pseudonymous_derived",
  achievement_journey_projection_outbox: "pseudonymous_derived",
  achievement_mutation_receipts: "no_personal_data",
  admin_permissions: "no_personal_data",
  analytics_contribution_receipts: "no_personal_data",
  analytics_daily_app: "no_personal_data",
  analytics_daily_buffer: "no_personal_data",
  analytics_daily_level: "no_personal_data",
  analytics_daily_runs: "no_personal_data",
  app_analytics_levels: "no_personal_data",
  app_availability_events: "no_personal_data",
  app_availability_mutation_receipts: "no_personal_data",
  app_client_assertion_replays: "no_personal_data",
  app_deployment_bindings: "no_personal_data",
  app_deployment_launch_controls: "no_personal_data",
  app_deployment_safety_observations: "no_personal_data",
  app_deployment_windows: "pseudonymous_derived",
  app_deployments: "no_personal_data",
  app_environment_publications: "no_personal_data",
  app_launch_availability: "no_personal_data",
  app_launch_exchange_receipts: "no_personal_data",
  app_maintenance_windows: "no_personal_data",
  app_progress_schema_migrations: "no_personal_data",
  app_progress_schemas: "no_personal_data",
  // display_name here is the APP's own display name (e.g. "Chess
  // Master"), not a person's — not personal data.
  app_registry: "no_personal_data",
  app_registry_audit_log: "pseudonymous_derived",
  app_registry_mutation_requests: "pseudonymous_derived",
  app_release_achievement_contracts: "no_personal_data",
  app_release_compatibility_reports: "no_personal_data",
  app_release_journey_contracts: "no_personal_data",
  app_releases: "no_personal_data",
  app_service_principals: "no_personal_data",
  app_session_grant_requests: "no_personal_data",
  app_session_grants: "pseudonymous_derived",
  approved_app_icons: "no_personal_data",
  approved_avatars: "no_personal_data",
  approved_domains: "no_personal_data",
  authorization_actions: "no_personal_data",
  authorization_policy_activation_history: "no_personal_data",
  authorization_policy_active: "no_personal_data",
  authorization_policy_bundles: "no_personal_data",
  // Pre-existing gap, not introduced by this catalog: stores a raw
  // recipient_email directly, unlike the newer NT-001 delivery table
  // (transactional_notification_deliveries) which stores only a
  // destination_hash. Catalogued honestly as direct_identifier rather
  // than silently reclassified — flagged here as a candidate for a future
  // minimization pass, not fixed as part of PC-001's own scope.
  billing_cancellation_notifications: "direct_identifier",
  billing_grace_job_runs: "no_personal_data",
  billing_job_runs: "no_personal_data",
  billing_mutation_requests: "no_personal_data",
  billing_periods: "no_personal_data",
  billing_recovery_notifications: "no_personal_data",
  checkout_activation_receipts: "no_personal_data",
  checkout_intents: "pseudonymous_derived",
  consent_acceptances: "no_personal_data",
  consent_records: "pseudonymous_derived",
  distributed_rate_limits: "pseudonymous_derived",
  consistency_mutation_receipts: "pseudonymous_derived",
  data_erasure_receipts: "pseudonymous_derived",
  monitoring_job_snapshots: "no_personal_data",
  monitoring_job_monthly_aggregates: "no_personal_data",
  disaster_recovery_test_records: "pseudonymous_derived",
  deployment_authorization_audit: "pseudonymous_derived",
  deployment_mutation_requests: "pseudonymous_derived",
  deployment_operation_requests: "no_personal_data",
  deployment_webhook_receipts: "no_personal_data",
  email_change_requests: "direct_identifier",
  email_verification_tokens: "pseudonymous_derived",
  entitlement_application_receipts: "no_personal_data",
  entitlement_cycles: "pseudonymous_derived",
  entitlement_integrity_incident_actions: "pseudonymous_derived",
  entitlement_integrity_incidents: "no_personal_data",
  entitlement_integrity_sweep_runs: "no_personal_data",
  entitlement_lifecycle_events: "pseudonymous_derived",
  entitlement_lifecycle_job_runs: "no_personal_data",
  entitlement_reconciliation_receipts: "no_personal_data",
  entitlement_state_transitions: "no_personal_data",
  entitlement_transition_receipts: "no_personal_data",
  financial_dispute_events: "no_personal_data",
  journey_mutation_receipts: "pseudonymous_derived",
  journey_retention_job_runs: "no_personal_data",
  launcher_freshness_metadata: "pseudonymous_derived",
  learner_achievements: "pseudonymous_derived",
  learner_app_consistency: "pseudonymous_derived",
  learner_app_consistency_weeks: "pseudonymous_derived",
  learner_app_effective_entitlements: "pseudonymous_derived",
  learner_app_effective_sources: "no_personal_data",
  learner_app_entitlement_periods: "pseudonymous_derived",
  learner_app_journey_events: "pseudonymous_derived",
  learner_app_progress: "pseudonymous_derived",
  learner_app_progress_integrity: "pseudonymous_derived",
  learner_app_standard_credit_batches: "pseudonymous_derived",
  learner_app_week_usage: "pseudonymous_derived",
  learner_creation_requests: "pseudonymous_derived",
  learner_journey_retention_state: "pseudonymous_derived",
  learner_launcher_freshness_receipts: "no_personal_data",
  learner_mode_unlock_receipts: "pseudonymous_derived",
  learner_passkey_credentials: "pseudonymous_derived",
  learner_profile_update_requests: "pseudonymous_derived",
  learner_progress_migration_receipts: "pseudonymous_derived",
  learner_selection_contexts: "pseudonymous_derived",
  learner_session_credits: "pseudonymous_derived",
  learner_session_launch_state: "pseudonymous_derived",
  learner_sessions: "pseudonymous_derived",
  learner_unlock_contexts: "pseudonymous_derived",
  learners: "restricted_child_data",
  learning_reminder_batches: "pseudonymous_derived",
  learning_reminder_deliveries: "no_personal_data",
  learning_reminder_items: "pseudonymous_derived",
  learning_reminder_job_runs: "no_personal_data",
  lesson_completions: "pseudonymous_derived",
  lesson_journey_projection_outbox: "pseudonymous_derived",
  notification_delivery_runs: "no_personal_data",
  notification_provider_webhook_receipts: "no_personal_data",
  notification_reconcile_runs: "no_personal_data",
  parent_email_history: "direct_identifier",
  parent_notification_preferences: "pseudonymous_derived",
  password_reset_tokens: "pseudonymous_derived",
  payment_method_update_sessions: "pseudonymous_derived",
  payment_provider_events: "no_personal_data",
  payments: "no_personal_data",
  platform_alerts: "no_personal_data",
  platform_governance_mutation_requests: "pseudonymous_derived",
  platform_operation_activity: "pseudonymous_derived",
  platform_operation_changes: "pseudonymous_derived",
  platform_recovery_codes: "pseudonymous_derived",
  platform_service_assertion_replays: "no_personal_data",
  platform_service_principals: "no_personal_data",
  product_prices: "no_personal_data",
  product_version_apps: "no_personal_data",
  products: "no_personal_data",
  profiles: "direct_identifier",
  progress_integrity_incident_actions: "pseudonymous_derived",
  progress_integrity_incidents: "pseudonymous_derived",
  progress_integrity_sweep_runs: "no_personal_data",
  progress_integrity_validation_receipts: "pseudonymous_derived",
  progress_mutation_requests: "pseudonymous_derived",
  progress_recovery_incidents: "pseudonymous_derived",
  progress_recovery_receipts: "pseudonymous_derived",
  recurring_agreement_setup_sessions: "pseudonymous_derived",
  refund_cases: "pseudonymous_derived",
  renewal_payment_attempts: "no_personal_data",
  session_exit_transition_receipts: "pseudonymous_derived",
  session_finalization_requests: "pseudonymous_derived",
  session_replacement_credits: "pseudonymous_derived",
  session_start_requests: "pseudonymous_derived",
  staff_accounts: "direct_identifier",
  staff_audit_log: "pseudonymous_derived",
  staff_auth_challenges: "pseudonymous_derived",
  staff_mutation_requests: "pseudonymous_derived",
  staff_passkey_credentials: "pseudonymous_derived",
  staff_reauth_receipts: "pseudonymous_derived",
  staff_recovery_sessions: "pseudonymous_derived",
  staff_role_assignments: "pseudonymous_derived",
  subscription_assignment_audit: "pseudonymous_derived",
  subscription_audit_log: "no_personal_data",
  subscription_reassignment_cases: "pseudonymous_derived",
  subscription_reassignment_requests: "pseudonymous_derived",
  subscription_renewal_reminders: "no_personal_data",
  subscriptions: "pseudonymous_derived",
  support_case_activity: "pseudonymous_derived",
  support_case_mutation_requests: "pseudonymous_derived",
  support_case_notes: "pseudonymous_derived",
  support_cases: "pseudonymous_derived",
  support_lookup_receipts: "pseudonymous_derived",
  technical_credit_claim_requests: "pseudonymous_derived",
  transactional_notification_deliveries: "no_personal_data",
  transactional_notification_intents: "pseudonymous_derived",
  usable_launch_requests: "pseudonymous_derived",
  users: "direct_identifier",
  webauthn_challenges: "pseudonymous_derived",
} as const;

export type FieldCatalogEntry = { column: string; purpose: string; requirementId: string };

// Field-level purpose + frozen-requirement traceability, required only for
// direct_identifier/restricted_child_data tables (rule: "every approved
// personal-data field/exposure maps to purpose + frozen requirement").
export const DIRECT_IDENTIFIER_FIELD_CATALOG: Record<string, FieldCatalogEntry[]> = {
  users: [
    { column: "email", purpose: "Sole account identifier and password-reset/notification address.", requirementId: "IA-001" },
    { column: "password_hash", purpose: "Slow-hashed credential for first-factor authentication.", requirementId: "IA-001" },
  ],
  profiles: [
    { column: "display_name", purpose: "Parent-facing greeting/display in the account UI.", requirementId: "IA-002" },
    { column: "phone_e164", purpose: "Optional contact number, format-validated only, never SMS-verified or used for OTP.", requirementId: "IA-002" },
    { column: "phone_country_code", purpose: "Formatting/display companion to phone_e164.", requirementId: "IA-002" },
  ],
  learners: [
    { column: "display_name", purpose: "Learner-facing and parent-facing identification within the family's own account only.", requirementId: "LP-001" },
    { column: "normalized_display_name", purpose: "Case/whitespace-insensitive uniqueness check within one parent's learners.", requirementId: "LP-001" },
    { column: "date_of_birth", purpose: "Derives age/age-band for content gating and analytics banding — never returned raw to any app-facing API.", requirementId: "LP-001" },
  ],
  staff_accounts: [
    { column: "normalized_email", purpose: "Staff sign-in identity, structurally separate from parent/learner identity.", requirementId: "AD-001" },
    { column: "display_name", purpose: "Staff-facing display in admin UI and audit trails.", requirementId: "AD-001" },
  ],
  parent_email_history: [
    { column: "email", purpose: "Immutable record of a superseded email address, required to detect reuse/collision on a later email change.", requirementId: "IA-002" },
  ],
  email_change_requests: [
    { column: "old_email", purpose: "Confirms the change request originated from the account's current verified address.", requirementId: "IA-002" },
    { column: "new_email", purpose: "Target address for the pending verification token.", requirementId: "IA-002" },
  ],
  billing_cancellation_notifications: [
    { column: "recipient_email", purpose: "Pre-existing BI-004 grace/cancellation notification delivery address (flagged for future hash-based minimization, see classification comment).", requirementId: "BI-004" },
  ],
};
