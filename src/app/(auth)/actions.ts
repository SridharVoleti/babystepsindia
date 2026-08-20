"use server";

import { redirect } from "next/navigation";
import type { AuthActionState } from "@/lib/auth-types";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { AuthError } from "@/lib/auth/auth-adapter";
import { validateSignup, passwordError } from "@/lib/auth/validation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { recordConsent, recordProcessingEnvelopeConsent } from "@/lib/db/consent";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { clearSessionCookie, getSession, setSessionCookie } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/auth-adapter";
import { revokeLearnerContextsForSession } from "@/lib/authorization/modes";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 5;

function localAuthUrl(path: string, token?: string) {
  // Tokens must never be returned to a production browser. Local/test mode
  // has no mail provider, so it exposes a link; unknown accounts receive an
  // indistinguishable dummy link that grants no authority.
  if (process.env.NODE_ENV === "production") return undefined;
  return `${process.env.NEXT_PUBLIC_SITE_URL}${path}?token=${token ?? crypto.randomUUID()}`;
}

async function startSession(user: AuthUser) {
  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    entitlements: await getEntitlementsForUser(user.id),
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
    return { error: validation.error, email: input.email.trim() };
  }

  if (!checkRateLimit(`signup:${validation.email}`, RATE_LIMIT_ATTEMPTS, 60 * 60 * 1000)) {
    return { error: "Too many attempts. Try again later.", email: validation.email };
  }

  let signUpResult;
  try {
    signUpResult = await sqliteAuthAdapter.signUp(validation.email, input.password);
  } catch (err) {
    if (err instanceof AuthError && err.code === "EMAIL_ALREADY_REGISTERED") {
      // Match the successful signup response shape so this public boundary
      // never confirms whether the submitted address is already registered.
      // Sending a fresh verification message, where applicable, affects only
      // the mailbox owner and gives the browser no additional authority.
      const resend = await sqliteAuthAdapter.resendVerification(validation.email);
      return {
        error: null,
        success: true,
        verificationUrl: localAuthUrl("/auth/confirm", resend?.token),
      };
    }
    throw err;
  }

  await recordConsent(signUpResult.user.id, "terms_of_service");
  await recordConsent(signUpResult.user.id, "privacy_policy");
  await recordProcessingEnvelopeConsent(signUpResult.user.id);

  // AC2/AC3: the profile already exists at this point (created inside
  // signUp) — protected data just stays gated until verification below.
  const verificationUrl = localAuthUrl("/auth/confirm", signUpResult.verificationToken);

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
    verificationUrl: localAuthUrl("/auth/confirm", resend?.token),
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
    resetUrl: localAuthUrl("/update-password", reset?.token),
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
  const session = await getSession();
  if (session?.sid) revokeLearnerContextsForSession(session.sid, new Date());
  clearSessionCookie();
  redirect("/");
}
