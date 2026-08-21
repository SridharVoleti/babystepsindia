// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  generatePasskeyRegistrationOptions, verifyPasskeyRegistration,
} from "@/lib/webauthn/postgres-service";
import { buildRegistrationResponse, createVirtualAuthenticator } from "./helpers/webauthn-virtual-authenticator";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("IA-004 staging Supabase/Postgres acceptance", () => {
  const db = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  const parentUserId = randomUUID(), learnerId = randomUUID();
  const actor = { parentUserId, learnerId, parentSessionId: randomUUID(), deviceSessionId: randomUUID() };
  const rpID = process.env.WEBAUTHN_RP_ID!;
  const origin = process.env.WEBAUTHN_ORIGIN!;

  beforeAll(async () => {
    await db.connect();
    await db.query("insert into auth.users(id,email,encrypted_password,aud,role) values($1,$2,'','authenticated','authenticated')", [parentUserId, `ia004-${Date.now()}@example.com`]);
    await db.query(`insert into learners(id,owner_parent_id,display_name,normalized_display_name,date_of_birth,locale,timezone)
      values($1,$2,'Asha','asha','2018-01-01','en-IN','Asia/Kolkata')`, [learnerId, parentUserId]);
  });
  afterAll(async () => {
    await db.query("delete from learner_passkey_credentials where learner_id=$1", [learnerId]);
    await db.query("delete from webauthn_challenges where learner_id=$1", [learnerId]);
    await db.query("delete from learners where id=$1", [learnerId]);
    await db.query("delete from auth.users where id=$1", [parentUserId]);
    await db.end();
  });

  it("allows exactly one concurrent consumer of a bound registration challenge", async () => {
    const { challengeId, options } = await generatePasskeyRegistrationOptions(actor);
    const response = buildRegistrationResponse(createVirtualAuthenticator(), { rpID, origin, challenge: options.challenge });
    const attempts = await Promise.allSettled([
      verifyPasskeyRegistration({ ...actor, challengeId, response, label: "Windows Hello" }),
      verifyPasskeyRegistration({ ...actor, challengeId, response, label: "Replay" }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    const consumed = await db.query("select consumed_at from webauthn_challenges where id=$1", [challengeId]);
    expect(consumed.rows[0].consumed_at).toBeTruthy();
  });
});
