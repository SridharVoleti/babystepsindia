import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import { ensureParentProfile } from "@/lib/auth/parent-profile";
import { getDb } from "@/lib/db/client";

beforeEach(() => {
  useInMemoryDb();
});

describe("sqliteParentProfileStore.find", () => {
  it("returns the profile created at signup", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const profile = await sqliteParentProfileStore.find(user.id);
    expect(profile).toEqual({
      id: user.id,
      account_status: "active",
      onboarding_status: "profile_pending",
      auth_revoked_before: null,
    });
  });

  it("returns null when no profile row exists", async () => {
    const profile = await sqliteParentProfileStore.find("does-not-exist");
    expect(profile).toBeNull();
  });
});

describe("sqliteParentProfileStore.insert (recovery path)", () => {
  it("creates the missing profile for an existing auth user, exactly once", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    // Simulate the profile-creation trigger having failed (AT-IA-001-03).
    getDb().prepare("delete from profiles where id = ?").run(user.id);
    expect(await sqliteParentProfileStore.find(user.id)).toBeNull();

    const first = await ensureParentProfile(sqliteParentProfileStore, user.id);
    expect(first.created).toBe(true);
    expect(first.profile.account_status).toBe("active");

    const second = await ensureParentProfile(sqliteParentProfileStore, user.id);
    expect(second.created).toBe(false);
    expect(second.profile).toEqual(first.profile);

    const profileCount = (
      getDb()
        .prepare("select count(*) as n from profiles where id = ?")
        .get(user.id) as { n: number }
    ).n;
    expect(profileCount).toBe(1);
  });

  it("never reactivates a suspended profile via recovery", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    getDb()
      .prepare("update profiles set account_status = 'suspended' where id = ?")
      .run(user.id);

    const result = await ensureParentProfile(sqliteParentProfileStore, user.id);
    expect(result.created).toBe(false);
    expect(result.profile.account_status).toBe("suspended");
  });
});
