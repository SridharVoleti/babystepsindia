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
  it("rejects malformed email and weak password at the server adapter boundary", async () => {
    await expect(sqliteAuthAdapter.signUp("not-an-email", "CorrectHorse1!"))
      .rejects.toMatchObject({ code: "INVALID_SIGNUP_INPUT" });
    await expect(sqliteAuthAdapter.signUp("parent@example.com", "short"))
      .rejects.toMatchObject({ code: "INVALID_SIGNUP_INPUT" });

    expect(getDb().prepare("select count(*) n from users").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select count(*) n from profiles").get()).toMatchObject({ n: 1 });
  });

  it("creates exactly one auth user and one parent profile (AT-IA-001-01)", async () => {
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
  it("rolls back token consumption when marking the email verified fails", async () => {
    const { verificationToken } = await sqliteAuthAdapter.signUp(
      "parent@example.com",
      "CorrectHorse1!",
    );
    getDb().exec(`create trigger fail_email_verification before update of email_verified_at on users
      begin select raise(abort, 'injected verification failure'); end`);

    await expect(sqliteAuthAdapter.verifyEmail(verificationToken))
      .rejects.toThrow("injected verification failure");

    getDb().exec("drop trigger fail_email_verification");
    expect((await sqliteAuthAdapter.verifyEmail(verificationToken))?.emailVerified).toBe(true);
  });

  it("marks the user verified, reuses the profile, and consumes the token (AT-IA-001-02)", async () => {
    const { verificationToken } = await sqliteAuthAdapter.signUp(
      "parent@example.com",
      "CorrectHorse1!",
    );

    const verified = await sqliteAuthAdapter.verifyEmail(verificationToken);
    expect(verified?.emailVerified).toBe(true);
    expect(getDb().prepare("select count(*) n from profiles where id=?").get(verified!.id))
      .toMatchObject({ n: 1 });

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
  it("normalizes email consistently for login and recovery adapter calls", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    expect(await sqliteAuthAdapter.signInWithPassword(
      "  Parent@Example.COM  ",
      "CorrectHorse1!",
    )).not.toBeNull();
    expect(await sqliteAuthAdapter.resendVerification("  Parent@Example.COM  "))
      .not.toBeNull();
    expect(await sqliteAuthAdapter.resetPasswordForEmail("  Parent@Example.COM  "))
      .not.toBeNull();
  });

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
  it("rejects a weak replacement before consuming the one-time reset token", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const reset = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");

    await expect(sqliteAuthAdapter.updatePassword(reset!.token, "short"))
      .rejects.toMatchObject({ code: "INVALID_PASSWORD" });

    const updated = await sqliteAuthAdapter.updatePassword(reset!.token, "NewPassword1!");
    expect(updated?.email).toBe("parent@example.com");
  });

  it("resets the password so the new one works and the old one does not (AT-IA-001-06)", async () => {
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

  it("invalidates every older reset link after one password reset succeeds", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const older = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");
    const newer = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");

    expect(await sqliteAuthAdapter.updatePassword(newer!.token, "NewPassword1!"))
      .not.toBeNull();
    expect(await sqliteAuthAdapter.updatePassword(older!.token, "AnotherPass1!"))
      .toBeNull();
  });

  it("rolls back token consumption when the password write fails", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const reset = await sqliteAuthAdapter.resetPasswordForEmail("parent@example.com");
    getDb().exec(`create trigger fail_password_reset before update of password_hash on users
      begin select raise(abort, 'injected password failure'); end`);

    await expect(sqliteAuthAdapter.updatePassword(reset!.token, "NewPassword1!"))
      .rejects.toThrow("injected password failure");

    getDb().exec("drop trigger fail_password_reset");
    expect(await sqliteAuthAdapter.updatePassword(reset!.token, "NewPassword1!"))
      .not.toBeNull();
  });

  it("returns null for an unregistered email without revealing that", async () => {
    const result = await sqliteAuthAdapter.resetPasswordForEmail("nobody@example.com");
    expect(result).toBeNull();
  });
});
