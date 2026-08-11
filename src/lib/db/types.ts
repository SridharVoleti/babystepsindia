export type User = {
  id: string;
  email: string;
  password_hash: string;
  is_admin: number;
  email_verified_at: string | null;
  created_at: string;
};

export type AccountStatus = "active" | "suspended" | "deleted";
export type OnboardingStatus = "profile_pending" | "learner_pending" | "complete";

export type Profile = {
  id: string;
  profile_type: "parent";
  display_name: string | null;
  phone_e164: string | null;
  phone_country_code: string | null;
  account_status: AccountStatus;
  onboarding_status: OnboardingStatus;
  locale: string;
  timezone: string;
  deleted_at: string | null;
  deleted_by_user_id: string | null;
  auth_revoked_before: string | null;
  created_at: string;
  updated_at: string;
};

export type ConsentType = "terms_of_service" | "privacy_policy";

export type ConsentRecord = {
  id: string;
  parent_user_id: string;
  consent_type: ConsentType;
  policy_version: string;
  granted: number;
  granted_at: string;
  revoked_at: string | null;
};

export type EmailChangeStatus = "pending" | "verified" | "expired" | "cancelled";

export type EmailChangeRequest = {
  id: string;
  parent_user_id: string;
  old_email: string;
  new_email: string;
  token_hash: string;
  status: EmailChangeStatus;
  requested_at: string;
  expires_at: string;
  verified_at: string | null;
  cancelled_at: string | null;
};

export type ParentEmailHistoryEntry = {
  id: string;
  parent_user_id: string;
  email: string;
  archived_at: string;
  reason: string;
};

export type AccountEvent = {
  id: string;
  parent_user_id: string;
  event_type: string;
  metadata: string | null;
  created_at: string;
};

export type ProductRow = {
  id: string;
  slug: string;
  name: string;
  subdomain: string;
  razorpay_plan_id: string;
  price_inr: number;
  product_type: "individual_app" | "bundle";
  version: number;
  status: "active" | "coming_soon" | "archived";
  created_at: string;
};

export type ProductPriceRow = {
  id: string;
  product_id: string;
  currency: string;
  billing_interval: "month" | "year";
  interval_count: number;
  unit_amount: number;
  pricing_rule_version: string;
  supports_non_renewing: number;
  status: "active" | "retired";
  effective_from: string;
  effective_to: string | null;
  version: number;
  created_at: string;
};

export type SubscriptionStatus =
  | "pending_payment"
  | "active"
  | "cancelling"
  | "cancelled"
  | "expired"
  | "past_due"
  | "refunded"
  | "charged_back"
  | "disputed"
  | "suspended_fraud";

export type Subscription = {
  id: string;
  user_id: string;
  type: "bundle" | "single";
  product_id: string;
  purchaser_parent_id: string;
  assigned_learner_id: string;
  product_version: number;
  status: SubscriptionStatus;
  cancel_at_period_end: number;
  auto_renew_enabled: number;
  provider: string;
  provider_environment: "test" | "production";
  provider_account_id: string | null;
  razorpay_subscription_id: string;
  provider_customer_ref: string | null;
  provider_payment_method_ref: string | null;
  provider_mandate_ref: string | null;
  provider_mandate_status: "unknown" | "valid" | "invalid" | "pending_setup";
  provider_subscription_ref: string | null;
  billing_price_id: string | null;
  billing_price_version: number | null;
  payment_state: "pending" | "paid" | "renewal_failed" | "past_due_grace" | "inactive_nonpayment" |
    "failed" | "overlap_resolution_required";
  grace_started_at: string | null;
  grace_ends_at: string | null;
  renewal_failure_at: string | null;
  last_recovery_attempt_at: string | null;
  recovery_version: number;
  nonpayment_ended_at: string | null;
  provider_retry_stop_state: "pending" | "confirmed" | "unsupported" | "failed" | null;
  started_at: string;
  current_period_start: string;
  current_period_end: string;
  next_renewal_at: string | null;
  billing_anchor_at: string | null;
  original_anchor_day: number | null;
  original_anchor_time: string | null;
  pending_reassignment_learner_id: string | null;
  pending_reassignment_effective_at: string | null;
  assignment_version: number;
  cancellation_requested_at: string | null;
  cancellation_effective_at: string | null;
  cancellation_reversed_at: string | null;
  cancellation_reason_code: "self_service" | null;
  cancellation_version: number;
  version: number;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Payment = {
  id: string;
  subscription_id: string;
  amount_inr: number;
  razorpay_payment_id: string;
  paid_at: string;
  created_at: string;
};

export type AuditLogEntry = {
  id: string;
  subscription_id: string | null;
  changed_by: string;
  change_type: string;
  old_status: string | null;
  new_status: string | null;
  note: string | null;
  created_at: string;
};

export type Entitlements = {
  bundle: boolean;
  products: string[];
};

export type Learner = {
  id: string;
  owner_parent_id: string;
  display_name: string;
  normalized_display_name: string;
  date_of_birth: string;
  avatar_id: string | null;
  version: number;
  locale: string;
  timezone: string;
  created_at: string;
  updated_at: string;
};

export type AppRegistryStatus = "draft" | "active" | "soft_deleted";

export type AppRegistryRow = {
  id: string;
  app_key: string;
  display_name: string;
  short_description: string | null;
  icon_asset_key: string | null;
  category: string | null;
  owning_team: string | null;
  internal_notes: string | null;
  registry_status: AppRegistryStatus;
  version: number;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  soft_deleted_at: string | null;
  soft_delete_reason_code: string | null;
};

// The "safe" read model — camelCase (API shape), internal_notes is
// always excluded (business rule 31 / AC24).
export type SafeAppRegistryView = {
  id: string;
  appKey: string;
  displayName: string;
  shortDescription: string | null;
  iconAssetKey: string | null;
  category: string | null;
  owningTeam: string | null;
  registryStatus: AppRegistryStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
  softDeletedAt: string | null;
  softDeleteReasonCode: string | null;
};

export type AppRegistryOperation = "create" | "edit" | "activate" | "soft_delete" | "restore";

export type AppRegistryPermission =
  | "app_registry_create"
  | "app_registry_edit"
  | "app_registry_activate"
  | "app_registry_soft_delete"
  | "app_registry_restore";

// AN-001
export type AgeBand =
  | "under_6" | "6_7" | "8_9" | "10_12" | "13_15" | "16_18" | "19_29" | "30_49" | "50_plus";

export type AnalyticsPermission = "analytics_read" | "analytics_run_retry" | "deployment_manage";

// AR-002 business rule 21: production promotion requires its own granular
// permission, distinct from the AU-001 window-scheduling deployment_manage
// permission above.
export type DeploymentPipelinePermission = "app_deployment_bind" | "app_deployment_promote";

// PR-004 rule 62: incident reads/actions require this exact permission
// plus recent reauthentication (enforced at the route layer).
export type ProgressIntegrityPermission = "progress_integrity_manage";

// BI-001: intentionally narrower than a generic billing/support role.
export type BillingPermission = "subscription_reassignment_manage";

// EN-003: gates the one admin-facing action that can immediately suspend a
// specific learner-app's access outside the normal billing lifecycle.
export type EntitlementLifecyclePermission = "entitlement_security_revoke";

// PR-002: a distinct "progress operations read" permission, per the spec's
// own API contract text — not folded into ProgressIntegrityPermission,
// since incident *actions* (PR-004) and recovery-incident *reads* (PR-002)
// are different operational surfaces.
export type ProgressRecoveryPermission = "progress_recovery_read";

export type AnalyticsRunStatus = "running" | "completed" | "failed";
