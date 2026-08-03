export type ParentProfile = {
  id: string;
  account_status: "active" | "suspended" | "deleted";
  onboarding_status: "profile_pending" | "learner_pending" | "complete";
};

// Store-injected so the same recovery logic runs against SQLite today and
// a Supabase-backed store later without changes here.
export type ParentProfileStore = {
  find(id: string): Promise<ParentProfile | null>;
  insert(id: string): Promise<ParentProfile>;
};

// AC5 / AT-IA-001-03: safe to call on every authenticated request — only
// inserts when the profile is truly missing (trigger failure recovery),
// never on the normal path where signup already created it.
export async function ensureParentProfile(store: ParentProfileStore, userId: string) {
  const existing = await store.find(userId);
  if (existing) {
    return { profile: existing, created: false };
  }
  return { profile: await store.insert(userId), created: true };
}

export type ParentAccessDenied = {
  allowed: false;
  code: "EMAIL_NOT_VERIFIED" | "PARENT_PROFILE_NOT_FOUND" | "ACCOUNT_SUSPENDED" | "ACCOUNT_DELETED";
};

export type ParentAccessAllowed = { allowed: true; code: null };

export function parentAccessDecision(input: {
  emailVerified: boolean;
  profile: Pick<ParentProfile, "account_status"> | null;
}): ParentAccessDenied | ParentAccessAllowed {
  if (!input.emailVerified) {
    return { allowed: false, code: "EMAIL_NOT_VERIFIED" };
  }
  if (!input.profile) {
    return { allowed: false, code: "PARENT_PROFILE_NOT_FOUND" };
  }
  if (input.profile.account_status === "suspended") {
    return { allowed: false, code: "ACCOUNT_SUSPENDED" };
  }
  if (input.profile.account_status === "deleted") {
    return { allowed: false, code: "ACCOUNT_DELETED" };
  }
  return { allowed: true, code: null };
}
