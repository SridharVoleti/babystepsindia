"use server";

import { redirect } from "next/navigation";
import type { AuthActionState } from "@/lib/auth-types";
import {
  authenticate,
  createPasswordResetToken,
  createUser,
  consumePasswordResetToken,
  findUserByEmail,
  findUserById,
  updateUserPassword,
} from "@/lib/db/users";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { clearSessionCookie, setSessionCookie } from "@/lib/auth/session";

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const user = authenticate(email, password);
  if (!user) {
    return { error: "Incorrect email or password." };
  }

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: !!user.is_admin,
    entitlements: getEntitlementsForUser(user.id),
  });

  redirect("/account");
}

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (findUserByEmail(email)) {
    return { error: "An account with that email already exists." };
  }

  const user = createUser(email, password, displayName || null);

  // No email provider in local dev mode — sign the new account in directly
  // rather than gating on a confirmation link that can't be sent.
  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: !!user.is_admin,
    entitlements: { bundle: false, products: [] },
  });

  redirect("/account");
}

export async function requestPasswordResetAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { error: "Enter your email." };
  }

  const user = findUserByEmail(email);
  if (!user) {
    // Don't reveal whether the account exists.
    return { error: null, success: true };
  }

  const token = createPasswordResetToken(user.id);
  const resetUrl = `${process.env.NEXT_PUBLIC_SITE_URL}/update-password?token=${token}`;

  return { error: null, success: true, resetUrl };
}

export async function updatePasswordAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  const token = String(formData.get("token") ?? "");

  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const userId = consumePasswordResetToken(token);
  if (!userId) {
    return { error: "This link is invalid or has expired. Request a new one." };
  }

  updateUserPassword(userId, password);

  const user = findUserById(userId)!;
  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: !!user.is_admin,
    entitlements: getEntitlementsForUser(user.id),
  });

  redirect("/account");
}

export async function signOutAction() {
  clearSessionCookie();
  redirect("/");
}
