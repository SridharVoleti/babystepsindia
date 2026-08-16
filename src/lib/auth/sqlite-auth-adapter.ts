import { normalizeEmail, passwordError } from "@/lib/auth/validation";
import { AuthError, type AuthAdapter, type AuthUser } from "@/lib/auth/auth-adapter";
import {
  authenticate,
  createEmailVerificationToken,
  createPasswordResetToken,
  createUser,
  findUserByEmail,
  findUserById,
  resetPasswordWithToken,
  verifyEmailWithToken,
} from "@/lib/db/users";
import type { User } from "@/lib/db/types";

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.email_verified_at,
    // AD-001: parent identities never carry admin authority — that's the
    // separate staff_accounts/staff session system now.
    isAdmin: false,
  };
}

export const sqliteAuthAdapter: AuthAdapter = {
  async signUp(email, password) {
    const normalized = normalizeEmail(email);
    if (!normalized || passwordError(password)) {
      throw new AuthError("INVALID_SIGNUP_INPUT");
    }

    if (findUserByEmail(normalized)) {
      throw new AuthError("EMAIL_ALREADY_REGISTERED");
    }

    // createUser inserts the users row and the parent profile row in one
    // transaction — the local stand-in for the idempotent auth.users
    // trigger (AC2: exactly one profile, created immediately).
    const user = createUser(normalized, password, null);
    const verificationToken = createEmailVerificationToken(user.id);

    return { user: toAuthUser(user), verificationToken };
  },

  async signInWithPassword(email, password) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const user = authenticate(normalized, password);
    return user ? toAuthUser(user) : null;
  },

  async verifyEmail(token) {
    const user = verifyEmailWithToken(token);
    return user ? toAuthUser(user) : null;
  },

  async resendVerification(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const user = findUserByEmail(normalized);
    if (!user) return null;

    return { token: createEmailVerificationToken(user.id) };
  },

  async resetPasswordForEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const user = findUserByEmail(normalized);
    if (!user) return null;

    return { token: createPasswordResetToken(user.id) };
  },

  async updatePassword(resetToken, password) {
    if (passwordError(password)) {
      throw new AuthError("INVALID_PASSWORD");
    }
    const user = resetPasswordWithToken(resetToken, password);
    return user ? toAuthUser(user) : null;
  },

  async getUserById(id) {
    const user = findUserById(id);
    return user ? toAuthUser(user) : null;
  },
};
