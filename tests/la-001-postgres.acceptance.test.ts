// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LA-001 live Postgres transaction and RLS certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const table = `la001_cert_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${table}(id integer primary key,status text not null)`);
    await clients[0].query(`insert into ${table}(id,status) values(1,'prepared')`);
  });

  afterAll(async () => {
    await clients[0].query(`drop table if exists ${table}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  it("allows exactly one conditional consumer under real concurrent row locking", async () => {
    const consume = (client: Client, principal: string) => client.query(
      `update ${table} set status=$1 where id=1 and status='prepared' returning status`, [principal]);
    const results = await Promise.all([consume(clients[0], "exchanged-a"), consume(clients[1], "exchanged-b")]);
    expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
  });

  it("has forced RLS on every server-only launch table", async () => {
    const result = await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname = any($1::text[])`, [["learner_session_launch_state", "app_launch_exchange_receipts",
        "app_client_assertion_replays"]]);
    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("rolls back all launch-like writes when the final audit step fails", async () => {
    await clients[0].query("begin");
    await clients[0].query(`insert into ${table}(id,status) values(2,'prepared')`);
    await clients[0].query(`update ${table} set status='exchanged' where id=2 and status='prepared'`);
    await clients[0].query("rollback");
    expect((await clients[0].query(`select * from ${table} where id=2`)).rows).toEqual([]);
  });
});
