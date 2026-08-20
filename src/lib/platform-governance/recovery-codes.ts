import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { RECOVERY_CODE_BATCH_SIZE } from "@/lib/platform-governance/contracts";

function formatRecoveryCode(): string {
  // High-entropy, readable in 4-char groups (rule 51). base64url avoids
  // ambiguous characters like a formatted UUID would carry.
  const raw = randomBytes(15).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  return raw.match(/.{1,4}/g)!.join("-");
}

// Same fast sha256 verifier used for WebAuthn challenge_hash
// (src/lib/webauthn/staff-service.ts) and app-launch codes
// (src/lib/app-launch/service.ts) — a deliberately different choice from
// hashPassword's slow scrypt, which exists to slow down guessing a
// *low*-entropy human-chosen password. These codes are already
// server-generated high-entropy secrets (rule 51), so a slow hash adds
// meaningful cost (~90ms/code) with no real security benefit, and would
// otherwise be paid on every bootstrap of every test's in-memory DB.
function hashRecoveryCode(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

type NewCodeRow = { id: string; plaintext: string };

// Rule 53: plaintext is generated here and returned exactly once — only
// the verifier_hash is ever persisted. Takes an already-open db handle
// rather than calling getDb() itself — bootstrapRecoveryCodes runs during
// openDb()'s own bootstrap step, before getDb()'s singleton is assigned
// (src/lib/db/client.ts), so a getDb() call from here would re-enter
// openDb() and recurse forever.
function generateCodeBatch(db: Database.Database, generation: number, createdByStaffId: string | null, now: Date): NewCodeRow[] {
  const timestamp = now.toISOString();
  const codes: NewCodeRow[] = [];
  for (let i = 0; i < RECOVERY_CODE_BATCH_SIZE; i += 1) {
    const plaintext = formatRecoveryCode();
    const id = randomUUID();
    db.prepare(
      `insert into platform_recovery_codes (id,generation,verifier_hash,status,created_by_staff_id,created_at)
       values (?,?,?,'active',?,?)`,
    ).run(id, generation, hashRecoveryCode(plaintext), createdByStaffId, timestamp);
    codes.push({ id, plaintext });
  }
  return codes;
}

// Called once from bootstrap.ts right after the first Platform
// Administrator is seeded — no admin session exists yet to show codes in
// the UI, so (matching the existing bootstrap-password precedent) they are
// logged to the server console exactly once. Takes the same already-open
// db handle bootstrapFirstPlatformAdministrator itself received, for the
// getDb() re-entrancy reason documented on generateCodeBatch above.
export function bootstrapRecoveryCodes(db: Database.Database, now = new Date()): NewCodeRow[] {
  const existing = db.prepare("select count(*) as n from platform_recovery_codes").get() as { n: number };
  if (existing.n > 0) return [];
  const codes = generateCodeBatch(db, 1, null, now);
  // eslint-disable-next-line no-console
  console.log(
    `[babysteps] Generated ${codes.length} sole-Platform-Administrator break-glass recovery codes ` +
      `(shown once, store offline): ${codes.map((c) => c.plaintext).join(", ")}`,
  );
  return codes;
}

// Async counterpart of generateCodeBatch above, for the DbClient-based
// callers below (rotateRecoveryCodes) — generateCodeBatch itself stays
// sync/raw-Database.Database-only, reserved for the openDb() bootstrap
// path that runs before getDb()'s singleton (and therefore
// resolveDbClient()) is even assignable, per its own comment.
async function generateCodeBatchAsync(tx: DbClient, generation: number, createdByStaffId: string | null, now: Date): Promise<NewCodeRow[]> {
  const timestamp = now.toISOString();
  const codes: NewCodeRow[] = [];
  for (let i = 0; i < RECOVERY_CODE_BATCH_SIZE; i += 1) {
    const plaintext = formatRecoveryCode();
    const id = randomUUID();
    await tx.run(
      `insert into platform_recovery_codes (id,generation,verifier_hash,status,created_by_staff_id,created_at)
       values (?,?,?,'active',?,?)`,
      [id, generation, hashRecoveryCode(plaintext), createdByStaffId, timestamp],
    );
    codes.push({ id, plaintext });
  }
  return codes;
}

// Rule 67: <=10-minute reauth is enforced by the route guard before this
// is called. Invalidates every currently-active code before issuing a
// fresh generation (rule 56: a used/revoked code can never be reused).
export async function rotateRecoveryCodes(actorStaffId: string, now = new Date()): Promise<{ codes: string[]; generation: number }> {
  return resolveDbClient().transaction(async (tx) => {
    const timestamp = now.toISOString();
    await tx.run("update platform_recovery_codes set status='revoked',revoked_at=? where status='active'", [timestamp]);
    const maxGeneration = await tx.get<{ g: number }>("select coalesce(max(generation),0) as g from platform_recovery_codes");
    const generation = (maxGeneration?.g ?? 0) + 1;
    const batch = await generateCodeBatchAsync(tx, generation, actorStaffId, now);
    return { codes: batch.map((c) => c.plaintext), generation };
  });
}

export type RecoveryCodeStatus = { activeCount: number; generation: number };

export async function getRecoveryCodeStatus(): Promise<RecoveryCodeStatus> {
  const row = await resolveDbClient().get<RecoveryCodeStatus>(
    "select count(*) as activeCount, coalesce(max(generation),0) as generation from platform_recovery_codes where status='active'",
  );
  return row!;
}

// Rule 58, 64: looked up directly by verifier hash (codes aren't stored in
// plaintext, but the hash itself is a deterministic sha256 of a
// high-entropy value, so an exact-match lookup carries no meaningful
// timing signal beyond what possessing the code already proves). Atomic
// single-use via an UPDATE guarded by status='active'; a race on the exact
// same code resolves to exactly one winner.
export async function consumeRecoveryCode(candidate: string, usedByStaffId: string, now: Date): Promise<boolean> {
  const db = resolveDbClient();
  const match = await db.get<{ id: string }>(
    "select id from platform_recovery_codes where status='active' and verifier_hash=?", [hashRecoveryCode(candidate)],
  );
  if (!match) return false;
  const result = await db.run(
    "update platform_recovery_codes set status='used',used_at=?,used_by_staff_id=? where id=? and status='active'",
    [now.toISOString(), usedByStaffId, match.id],
  );
  return result.changes === 1;
}
