import { normalizeEmail } from "@/lib/auth/validation";
import { AuthError, type AuthAdapter, type AuthUser } from "@/lib/auth/auth-adapter";
import {
  authenticate,
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  createUser,
  findUserByEmail,
  findUserById,
  markEmailVerified,
  updateUserPassword,
} from "@/lib/db/users";
import type { User } from "@/lib/db/types";

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.email_verified_at,
    isAdmin: !!user.is_admin,
  };
}

export const sqliteAuthAdapter: AuthAdapter = {
  async signUp(email, password) {
    const normalized = normalizeEmail(email) ?? email.trim().toLowerCase();

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
    const user = authenticate(email, password);
    return user ? toAuthUser(user) : null;
  },

  async verifyEmail(token) {
    const userId = consumeEmailVerificationToken(token);
    if (!userId) return null;

    markEmailVerified(userId);
    const user = findUserById(userId);
    return user ? toAuthUser(user) : null;
  },

  async resendVerification(email) {
    const user = findUserByEmail(email);
    if (!user) return null;

    return { token: createEmailVerificationToken(user.id) };
  },

  async resetPasswordForEmail(email) {
    const user = findUserByEmail(email);
    if (!user) return null;

    return { token: createPasswordResetToken(user.id) };
  },

  async updatePassword(resetToken, password) {
    const userId = consumePasswordResetToken(resetToken);
    if (!userId) return null;

    updateUserPassword(userId, password);
    const user = findUserById(userId);
    return user ? toAuthUser(user) : null;
  },

  async getUserById(id) {
    const user = findUserById(id);
    return user ? toAuthUser(user) : null;
  },
};
