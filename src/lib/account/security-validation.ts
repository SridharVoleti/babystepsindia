import { normalizeEmail, passwordError } from "@/lib/auth/validation";

export type ValidateEmailResult =
  | { ok: true; email: string }
  | { ok: false; code: "EMAIL_INVALID" | "EMAIL_UNCHANGED"; error: string };

// Availability against other Auth identities (business rule 4) is a DB
// lookup, not a pure check — that happens in the repo/route layer, same
// split as IA-001's signup validation vs. sqliteAuthAdapter.signUp.
export function validateNewEmail(input: {
  currentEmail: string;
  newEmail: string;
}): ValidateEmailResult {
  const normalized = normalizeEmail(input.newEmail);
  if (!normalized) {
    return { ok: false, code: "EMAIL_INVALID", error: "Enter a valid email address." };
  }
  if (normalized === input.currentEmail.trim().toLowerCase()) {
    return { ok: false, code: "EMAIL_UNCHANGED", error: "Enter a different email address." };
  }
  return { ok: true, email: normalized };
}

export type ValidatePasswordFormatResult =
  | { ok: true }
  | { ok: false; code: "PASSWORD_INVALID" | "PASSWORD_MISMATCH"; error: string };

// Whether the new password differs from the current one requires
// verifying against the stored hash — that's checked in the repo/route
// layer via sqliteAuthAdapter.signInWithPassword(email, newPassword),
// reusing the existing reauth check rather than adding new crypto code.
export function validateNewPasswordFormat(input: {
  newPassword: string;
  confirmPassword: string;
}): ValidatePasswordFormatResult {
  const error = passwordError(input.newPassword);
  if (error) {
    return { ok: false, code: "PASSWORD_INVALID", error };
  }
  if (input.newPassword !== input.confirmPassword) {
    return { ok: false, code: "PASSWORD_MISMATCH", error: "Passwords do not match." };
  }
  return { ok: true };
}

// High-friction confirmation for soft delete — exact text, no trimming or
// case-folding, so it can't be satisfied accidentally.
export function validateDeleteConfirmation(text: string): boolean {
  return text === "DELETE";
}
