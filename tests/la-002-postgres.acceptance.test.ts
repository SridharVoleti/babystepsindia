// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LA-002 staging Supabase/Postgres grant certification", () => {
  const clients = [0, 1, 2].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const table = `la002_cert_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${table}(
      id uuid primary key, learner_session_id uuid not null unique,
      status text not null check(status in ('provisional','active','revoked')),
      grant_version integer not null default 1, scopes_json jsonb not null)`);
  });

  afterAll(async () => {
    await clients[0].query(`drop table if exists ${table}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  it("allows exactly one grant for concurrent duplicate launch confirmations", async () => {
    const sessionId = randomUUID();
    const issue = (client: Client) => client.query(`insert into ${table}
      (id,learner_session_id,status,scopes_json) values($1,$2,'provisional',$3)
      on conflict(learner_session_id) do nothing returning id`,
    [randomUUID(), sessionId, JSON.stringify(["launch:confirm"])]);
    const results = await Promise.all(clients.slice(0, 2).map(issue));
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
    expect((await clients[0].query(`select count(*)::int n from ${table} where learner_session_id=$1`,
      [sessionId])).rows[0].n).toBe(1);
  });

  it("keeps activation and revocation retry-safe without scope resurrection", async () => {
    const id = randomUUID(), sessionId = randomUUID();
    await clients[0].query(`insert into ${table}(id,learner_session_id,status,scopes_json)
      values($1,$2,'provisional',$3)`, [id, sessionId, JSON.stringify(["launch:confirm"])]);
    const activate = () => clients[0].query(`update ${table} set status='active',grant_version=grant_version+1,
      scopes_json=$2 where id=$1 and status='provisional'`, [id, JSON.stringify(["progress:read","progress:write"])]);
    expect((await activate()).rowCount).toBe(1);
    expect((await activate()).rowCount).toBe(0);
    const revoke = () => clients[1].query(`update ${table} set status='revoked',grant_version=grant_version+1
      where id=$1 and status in ('provisional','active')`, [id]);
    expect((await revoke()).rowCount).toBe(1);
    expect((await revoke()).rowCount).toBe(0);
    expect((await activate()).rowCount).toBe(0);
    expect((await clients[2].query(`select status,grant_version,scopes_json from ${table} where id=$1`, [id])).rows[0])
      .toMatchObject({ status: "revoked", grant_version: 3,
        scopes_json: ["progress:read", "progress:write"] });
  });

  it("has forced RLS on all server-only authorization tables", async () => {
    const result = await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname = any($1::text[])`, [["app_session_grants", "app_session_grant_requests",
        "app_client_assertion_replays"]]);
    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
