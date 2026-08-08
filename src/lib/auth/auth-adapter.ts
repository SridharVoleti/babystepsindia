// IA-001 Codex notes: "Keep authentication behind an AuthAdapter interface
// so future providers can be added without changing parent IDs." This is
// the seam — sqlite-auth-adapter.ts is the only implementation today; a
// supabase-auth-adapter.ts implementing the same interface is the intended
// swap when a Supabase project is provisioned. Callers (server actions,
// route handlers) depend only on this interface.

export type AuthUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
};

export type AuthErrorCode =
  | "EMAIL_ALREADY_REGISTERED"
  | "INVALID_SIGNUP_INPUT"
  | "INVALID_PASSWORD";

export class AuthError extends Error {
  code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface AuthAdapter {
  signUp(
    email: string,
    password: string,
  ): Promise<{ user: AuthUser; verificationToken: string }>;

  signInWithPassword(email: string, password: string): Promise<AuthUser | null>;

  verifyEmail(token: string): Promise<AuthUser | null>;

  resendVerification(email: string): Promise<{ token: string } | null>;

  resetPasswordForEmail(email: string): Promise<{ token: string } | null>;

  updatePassword(resetToken: string, password: string): Promise<AuthUser | null>;

  getUserById(id: string): Promise<AuthUser | null>;
}
