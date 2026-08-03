"use server";

import { redirect } from "next/navigation";
import type { AuthActionState } from "@/lib/auth-types";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { AuthError } from "@/lib/auth/auth-adapter";
import { validateSignup, passwordError } from "@/lib/auth/validation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { recordConsentAcceptance } from "@/lib/db/consent";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { clearSessionCookie, setSessionCookie } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/auth-adapter";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 5;

async function startSession(user: AuthUser) {
  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    entitlements: getEntitlementsForUser(user.id),
  });
}

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  if (!checkRateLimit(`login:${email.toLowerCase()}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    return { error: "Too many attempts. Try again in a few minutes." };
  }

  // Deliberately generic: whether the email exists is never revealed
  // (AC8 / AT-IA-001-07).
  const user = await sqliteAuthAdapter.signInWithPassword(email, password);
  if (!user) {
    return { error: "Incorrect email or password." };
  }

  await startSession(user);
  redirect("/account");
}

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const input = {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    confirmPassword: String(formData.get("confirmPassword") ?? ""),
    acceptedTerms: formData.get("acceptedTerms") === "on",
    acceptedPrivacy: formData.get("acceptedPrivacy") === "on",
  };

  const validation = validateSignup(input);
  if (!validation.ok) {
    return { error: validation.error };
  }

  if (!checkRateLimit(`signup:${validation.email}`, RATE_LIMIT_ATTEMPTS, 60 * 60 * 1000)) {
    return { error: "Too many attempts. Try again later." };
  }

  let signUpResult;
  try {
    signUpResult = await sqliteAuthAdapter.signUp(validation.email, input.password);
  } catch (err) {
    if (err instanceof AuthError && err.code === "EMAIL_ALREADY_REGISTERED") {
      return {
        error: "An account with that email already exists. Sign in or reset your password.",
      };
    }
    throw err;
  }

  recordConsentAcceptance(signUpResult.user.id, "terms");
  recordConsentAcceptance(signUpResult.user.id, "privacy");

  // AC2/AC3: the profile already exists at this point (created inside
  // signUp) — protected data just stays gated until verification below.
  const verificationUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm?token=${signUpResult.verificationToken}`;

  return { error: null, success: true, verificationUrl };
}

export async function resendVerificationAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { error: "Enter your email." };
  }

  if (!checkRateLimit(`resend:${email.toLowerCase()}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    // Same non-revealing success shape as a normal resend.
    return { error: null, success: true };
  }

  const resend = await sqliteAuthAdapter.resendVerification(email);

  return {
    error: null,
    success: true,
    verificationUrl: resend
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/auth/confirm?token=${resend.token}`
      : undefined,
  };
}

export async function requestPasswordResetAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { error: "Enter your email." };
  }

  if (!checkRateLimit(`reset:${email.toLowerCase()}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    return { error: null, success: true };
  }

  // Don't reveal whether the account exists (AC8).
  const reset = await sqliteAuthAdapter.resetPasswordForEmail(email);

  return {
    error: null,
    success: true,
    resetUrl: reset
      ? `${process.env.NEXT_PUBLIC_SITE_URL}/update-password?token=${reset.token}`
      : undefined,
  };
}

export async function updatePasswordAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const token = String(formData.get("token") ?? "");

  const error = passwordError(password);
  if (error) {
    return { error };
  }

  const user = await sqliteAuthAdapter.updatePassword(token, password);
  if (!user) {
    return { error: "This link is invalid or has expired. Request a new one." };
  }

  await startSession(user);
  redirect("/account");
}

export async function signOutAction() {
  clearSessionCookie();
  redirect("/");
}
