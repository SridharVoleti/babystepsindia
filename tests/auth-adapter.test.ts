import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { AuthError } from "@/lib/auth/auth-adapter";
import { findUserByEmail } from "@/lib/db/users";
import { getDb } from "@/lib/db/client";

beforeEach(() => {
  useInMemoryDb();
});

describe("sqliteAuthAdapter.signUp", () => {
  it("creates exactly one auth user and one parent profile", async () => {
    const { user } = await sqliteAuthAdapter.signUp(
      "Parent@Example.com",
      "CorrectHorse1!",
    );

    expect(user.email).toBe("parent@example.com");
    expect(user.emailVerified).toBe(false);

    const profileCount = (
      getDb().prepare("select count(*) as n from profiles where id = ?").get(user.id) as {
        n: number;
      }
    ).n;
    expect(profileCount).toBe(1);

    const profile = getDb()
      .prepare("select * from profiles where id = ?")
      .get(user.id) as { account_status: string; onboarding_status: string };
    expect(profile.account_status).toBe("active");
    expect(profile.onboarding_status).toBe("profile_pending");
  });

  it("returns a verification token that is not the password", async () => {
    const { verificationToken } = await sqliteAuthAdapter.signUp(
      "parent@example.com",
      "CorrectHorse1!",
    );
    expect(verificationToken).toBeTruthy();
    expect(verificationToken).not.toBe("CorrectHorse1!");
  });

  it("rejects a second registration with the same email and creates no second profile", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    await expect(
      sqliteAuthAdapter.signUp("parent@example.com", "AnotherPass1!"),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED" });

    const userCount = (
      getDb()
        .prepare("select count(*) as n from users where email = ?")
        .get("parent@example.com") as { n: number }
    ).n;
    const profileCount = (
      getDb()
        .prepare(
          "select count(*) as n from profiles where id in (select id from users where email = ?)",
        )
        .get("parent@example.com") as { n: number }
    ).n;
    expect(userCount).toBe(1);
    expect(profileCount).toBe(1);
  });

  it("normalizes email casing/whitespace before storing", async () => {
    await sqliteAuthAdapter.signUp("  Parent@Example.com  ", "CorrectHorse1!");
    expect(findUserByEmail("parent@example.com")).toBeTruthy();
  });
});

describe("sqliteAuthAdapter.verifyEmail", () => {
  it("marks the user verified and consumes the token", async () => {
    const { verificationToken } = await sqliteAuthAdapter.signUp(
      "parent@example.com",
      "CorrectHorse1!",
    );

    const verified = await sqliteAuthAdapter.verifyEmail(verificationToken);
    expect(verified?.emailVerified).toBe(true);

    // Replayed confirmation link must not blow up or un-verify anything.
    const replay = await sqliteAuthAdapter.verifyEmail(verificationToken);
    expect(replay).toBeNull();
  });

  it("rejects an unknown token", async () => {
    const result = await sqliteAuthAdapter.verifyEmail("does-not-exist");
    expect(result).toBeNull();
  });
});

describe("sqliteAuthAdapter.resendVerification", () => {
  it("issues a new token that also verifies the account, and invalidates the old one", async () => {
    const { verificationToken: first } = await sqliteAuthAdapter.signUp(
      "parent@example.com",
      "CorrectHorse1!",
    );

    const resend = await sqliteAuthAdapter.resendVerification("parent@example.com");
    expect(resend?.token).toBeTruthy();
    expect(resend?.token).not.toBe(first);

    expect(await sqliteAuthAdapter.verifyEmail(first)).toBeNull();
    expect((await sqliteAuthAdapter.verifyEmail(resend!.token))?.emailVerified).toBe(true);
  });

  it("returns null for an unregistered email without revealing that", async () => {
    const result = await sqliteAuthAdapter.resendVerification("nobody@example.com");
    expect(result).toBeNull();
  });
});

describe("sqliteAuthAdapter.signInWithPassword", () => {
  it("returns the user for correct credentials", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const user = await sqliteAuthAdapter.signInWithPassword(
      "parent@example.com",
      "CorrectHorse1!",
    );
    expect(user?.email).toBe("parent@example.com");
  });

  it("returns null identically for a wrong password and for an unknown email", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const wrongPassword = await sqliteAuthAdapter.signInWithPassword(
      "parent@example.com",
      "WrongPass1!",
    );
    const unknownEmail = await sqliteAuthAdapter.signInWithPassword(
      "nobody@example.com",
      "WrongPass1!",
    );
    expect(wrongPassword).toBeNull();
    expect(unknownEmail).toBeNull();
  });
});

describe("sqliteAuthAdapter password reset", () => {
  it("resets the password so the new one works and the old one does not", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const reset = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");

    const updated = await sqliteAuthAdapter.updatePassword(reset!.token, "NewPassword1!");
    expect(updated?.email).toBe("parent@example.com");

    expect(
      await sqliteAuthAdapter.signInWithPassword("parent@example.com", "CorrectHorse1!"),
    ).toBeNull();
    expect(
      await sqliteAuthAdapter.signInWithPassword("parent@example.com", "NewPassword1!"),
    ).not.toBeNull();
  });

  it("rejects a reused or expired reset token", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const reset = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");
    await sqliteAuthAdapter.updatePassword(reset!.token, "NewPassword1!");

    const replay = await sqliteAuthAdapter.updatePassword(reset!.token, "AnotherPass1!");
    expect(replay).toBeNull();
  });

  it("returns null for an unregistered email without revealing that", async () => {
    const result = await sqliteAuthAdapter.resetPasswordForEmail("nobody@example.com");
    expect(result).toBeNull();
  });
});
