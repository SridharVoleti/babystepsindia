// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  requestPasswordResetAction,
  resendVerificationAction,
  signUpAction,
} from "@/app/(auth)/actions";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { useInMemoryDb } from "@/lib/db/test-utils";

function validSignup(email: string) {
  const form = new FormData();
  form.set("email", email);
  form.set("password", "CorrectHorse1!");
  form.set("confirmPassword", "CorrectHorse1!");
  form.set("acceptedTerms", "on");
  form.set("acceptedPrivacy", "on");
  return form;
}

function emailOnly(email: string) {
  const form = new FormData();
  form.set("email", email);
  return form;
}

describe("IA-001 authentication actions", () => {
  beforeEach(() => {
    useInMemoryDb();
    resetRateLimitsForTests();
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost";
  });

  it("AT-IA-001-07 does not disclose that a signup email is already registered", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    const result = await signUpAction(
      { error: null },
      validSignup("parent@example.com"),
    );

    expect(result).toMatchObject({ error: null, success: true });
    expect(result.error ?? "").not.toMatch(/already exists|registered/i);
  });

  it("AT-IA-001-07 gives registered and unknown recovery requests the same public shape", async () => {
    await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");

    const registeredReset = await requestPasswordResetAction(
      { error: null },
      emailOnly("parent@example.com"),
    );
    const unknownReset = await requestPasswordResetAction(
      { error: null },
      emailOnly("unknown@example.com"),
    );
    const registeredResend = await resendVerificationAction(
      { error: null },
      emailOnly("parent@example.com"),
    );
    const unknownResend = await resendVerificationAction(
      { error: null },
      emailOnly("unknown@example.com"),
    );

    expect({ ...registeredReset, resetUrl: Boolean(registeredReset.resetUrl) })
      .toEqual({ ...unknownReset, resetUrl: Boolean(unknownReset.resetUrl) });
    expect({ ...registeredResend, verificationUrl: Boolean(registeredResend.verificationUrl) })
      .toEqual({ ...unknownResend, verificationUrl: Boolean(unknownResend.verificationUrl) });
  });
});
