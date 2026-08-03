export type AuthActionState = {
  error: string | null;
  success?: boolean;
  // Local dev mode only — there's no email provider wired up, so the
  // reset link is handed back to the form instead of emailed.
  resetUrl?: string;
};

export const initialAuthState: AuthActionState = { error: null };
