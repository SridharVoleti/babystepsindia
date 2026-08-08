export type AuthActionState = {
  error: string | null;
  // Safe retry state. Passwords and tokens are deliberately never returned
  // to the client after validation or authentication failures.
  email?: string;
  success?: boolean;
  // Local dev mode only — there's no email provider wired up, so the
  // reset/verification link is handed back to the form instead of emailed.
  resetUrl?: string;
  verificationUrl?: string;
};

export const initialAuthState: AuthActionState = { error: null };
