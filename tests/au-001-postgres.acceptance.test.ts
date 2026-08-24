// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("AU-001 staging Supabase/Postgres runtime authorization certification", () => {
  const clients = [0, 1].map(() => new Client({ connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false } }));
  const suffix = randomUUID().replaceAll("-", "");
  const resources = `au001_resources_${suffix}`;
  const privileges = `au001_privileges_${suffix}`;
  const owned = `au001_owned_${suffix}`;

  beforeAll(async () => {
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].query(`create table ${resources}(id uuid primary key,owner_id uuid not null,
      value text not null,version integer not null)`);
    await clients[0].query(`create table ${privileges}(id uuid primary key,active boolean not null,
      use_count integer not null,version integer not null)`);
    await clients[0].query(`create table ${owned}(id uuid primary key,owner_id uuid not null,value text not null)`);
    await clients[0].query(`alter table ${owned} enable row level security; alter table ${owned} force row level security;
      create policy owner_read on ${owned} for select to authenticated using(auth.uid()=owner_id);
      grant select on ${owned} to authenticated`);
  });

  afterAll(async () => {
    await clients[0].query(`drop table if exists ${resources}`);
    await clients[0].query(`drop table if exists ${privileges}`);
    await clients[0].query(`drop table if exists ${owned}`);
    await Promise.all(clients.map((client) => client.end()));
  });

  async function asAuthenticated<T>(claims: Record<string, unknown>, query: (client: Client) => Promise<T>) {
    const client = clients[0];
    await client.query("begin");
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      const result = await query(client);
      await client.query("rollback");
      return result;
    } catch (error) { await client.query("rollback"); throw error; }
  }

  it("separates actor identity from resource ownership and denies cross-parent reads", async () => {
    const actorId = randomUUID(); const otherId = randomUUID();
    await clients[0].query(`insert into ${owned} values($1,$1,'mine'),($2,$2,'foreign')`, [actorId, otherId]);
    const rows = await asAuthenticated({ sub: actorId, role: "authenticated" }, (client) =>
      client.query(`select owner_id,value from ${owned}`));
    expect((rows as any).rows).toEqual([{ owner_id: actorId, value: "mine" }]);
  });

  it("keeps direct database access deny-by-default beyond service authorization", async () => {
    const rows = await asAuthenticated({ sub: randomUUID(), role: "authenticated" }, (client) =>
      client.query("select * from authorization_policy_bundles"));
    expect((rows as any).rows).toHaveLength(0);
    await expect(asAuthenticated({ sub: randomUUID(), role: "authenticated" }, (client) =>
      client.query("insert into authorization_policy_bundles default values"))).rejects.toMatchObject({ code: "42501" });
  });

  it("fails closed when verified actor context is absent", async () => {
    const rows = await asAuthenticated({}, (client) => client.query("select id from profiles"));
    expect((rows as any).rows).toHaveLength(0);
  });

  it("rejects a stale allow after a concurrent ownership change", async () => {
    const id = randomUUID(); const ownerA = randomUUID(); const ownerB = randomUUID();
    await clients[0].query(`insert into ${resources} values($1,$2,'original',1)`, [id, ownerA]);
    const decision = (await clients[0].query(`select owner_id,version from ${resources} where id=$1`, [id])).rows[0];
    expect(decision).toMatchObject({ owner_id: ownerA, version: 1 });
    await clients[1].query(`update ${resources} set owner_id=$2,version=2 where id=$1 and version=1`, [id, ownerB]);
    const mutation = await clients[0].query(`update ${resources} set value='forged',version=2
      where id=$1 and owner_id=$2 and version=$3 returning id`, [id, ownerA, decision.version]);
    expect(mutation.rowCount).toBe(0);
    expect((await clients[0].query(`select owner_id,value from ${resources} where id=$1`, [id])).rows[0])
      .toEqual({ owner_id: ownerB, value: "original" });
  });

  it("rechecks privilege state at mutation time after concurrent revocation", async () => {
    const id = randomUUID();
    await clients[0].query(`insert into ${privileges} values($1,true,0,1)`, [id]);
    const observed = (await clients[0].query(`select active,version from ${privileges} where id=$1`, [id])).rows[0];
    expect(observed).toEqual({ active: true, version: 1 });
    await clients[1].query(`update ${privileges} set active=false,version=2 where id=$1 and version=1`, [id]);
    const used = await clients[0].query(`update ${privileges} set use_count=use_count+1,version=version+1
      where id=$1 and active and version=$2 returning id`, [id, observed.version]);
    expect(used.rowCount).toBe(0);
    expect((await clients[0].query(`select active,use_count from ${privileges} where id=$1`, [id])).rows[0])
      .toEqual({ active: false, use_count: 0 });
  });

  it("forces RLS on every live public table in the certified environment", async () => {
    const gaps = await clients[0].query(`select relname from pg_class join pg_namespace n on n.oid=relnamespace
      where n.nspname='public' and relkind='r' and (not relrowsecurity or not relforcerowsecurity)
      and relname not in ($1,$2,$3) order by relname`, [resources, privileges, owned]);
    expect(gaps.rows).toEqual([]);
    const env = await clients[0].query("select current_database() database,current_setting('server_version') version");
    expect(env.rows[0].database).toBeTruthy();
    expect(env.rows[0].version).toBeTruthy();
  });
});
