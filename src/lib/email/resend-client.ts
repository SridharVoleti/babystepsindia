import { Resend } from "resend";

// Auth email delivery (signup verification, resend-verification, password
// reset). Only active when RESEND_API_KEY is set — local/test runs have no
// key, so this silently no-ops there, matching the pre-existing "local/test
// mode has no mail provider" behavior in src/app/(auth)/actions.ts.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "BabySteps <noreply@babystepsindia.com>";

export async function sendAuthEmail(input: { to: string; subject: string; text: string; html: string }) {
  if (!resend) return;
  // The Resend SDK returns { data, error } rather than throwing on API
  // rejection (e.g. an unverified sending domain) — a caller that only
  // awaits the call and ignores the result never learns the send failed.
  const { error } = await resend.emails.send({
    from: EMAIL_FROM, to: input.to, subject: input.subject, html: input.html, text: input.text,
  });
  if (error) console.error("[resend-client] send failed:", error);
}
