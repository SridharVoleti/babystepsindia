import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

const MAX_RECEIPT_LIFETIME_MS = 60_000;

/**
 * Trusted integration seam for IA-004. The WebAuthn verifier calls this only
 * after validating the challenge, origin, RP ID, signature counter and exact
 * registered learner credential. No browser route exposes this function.
 */
export function recordTrustedPasskeyVerification(input: {
  parentUserId: string;
  parentSessionId: string;
  deviceSessionId: string;
  learnerId: string;
  credentialId: string;
  verifiedAt: Date;
  expiresAt: Date;
}) {
  const lifetime = input.expiresAt.getTime() - input.verifiedAt.getTime();
  if (lifetime <= 0 || lifetime > MAX_RECEIPT_LIFETIME_MS) {
    throw new Error("PASSKEY_VERIFICATION_RECEIPT_EXPIRY_INVALID");
  }
  const id = randomUUID();
  getDb().prepare(`insert into learner_mode_unlock_receipts
    (id,parent_user_id,parent_session_id,device_session_id,learner_id,credential_id,verified_at,expires_at)
    values(?,?,?,?,?,?,?,?)`).run(id,input.parentUserId,input.parentSessionId,input.deviceSessionId,input.learnerId,
    input.credentialId,input.verifiedAt.toISOString(),input.expiresAt.toISOString());
  return { id, expiresAt: input.expiresAt.toISOString() };
}
