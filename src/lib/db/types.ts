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
  account_status: AccountStatus;
  onboarding_status: OnboardingStatus;
  locale: string;
  timezone: string;
  created_at: string;
  updated_at: string;
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
