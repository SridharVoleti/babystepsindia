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
  date_of_birth: string | null;
  class_level: string | null;
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
  token: string;
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
  status: "active" | "coming_soon" | "archived";
  created_at: string;
};

export type SubscriptionStatus =
  | "active"
  | "cancelling"
  | "cancelled"
  | "expired"
  | "past_due";

export type Subscription = {
  id: string;
  user_id: string;
  type: "bundle" | "single";
  product_id: string | null;
  status: SubscriptionStatus;
  cancel_at_period_end: number;
  razorpay_subscription_id: string;
  started_at: string;
  current_period_end: string;
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
