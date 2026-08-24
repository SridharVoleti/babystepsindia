// @vitest-environment node
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";

const live=process.env.RUN_SUPABASE_ACCEPTANCE==="1"?describe:describe.skip;
live("PR-001 staging Postgres migration certification",()=>{
  const clients=[0,1].map(()=>new Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}}));
  const suffix=randomUUID().replaceAll("-",""),progress=`pr001_progress_${suffix}`,receipts=`pr001_receipts_${suffix}`;
  beforeAll(async()=>{await Promise.all(clients.map(c=>c.connect()));await clients[0].query(`
    create table ${progress}(learner_id uuid,app_id uuid,schema_version int not null,progress_version int not null,state_json jsonb,
      state_hash text not null,last_receipt_id uuid,primary key(learner_id,app_id));
    create table ${receipts}(id uuid primary key,learner_id uuid,app_id uuid,release_id uuid,from_version int,
      to_version int,state_hash_after text,unique(learner_id,app_id,release_id,to_version))`)});
  afterAll(async()=>{await clients[0].query(`drop table if exists ${receipts};drop table if exists ${progress}`);
    await Promise.all(clients.map(c=>c.end()))});

  it("allows only one concurrent migration receipt and one optimistic state transition",async()=>{
    const learner=randomUUID(),app=randomUUID(),release=randomUUID();
    await clients[0].query(`insert into ${progress} values($1,$2,1,7,'{"level":"one"}','before',null)`,[learner,app]);
    const migrate=async(client:Client)=>{await client.query("begin");try{
      const receipt=randomUUID();const inserted=await client.query(`insert into ${receipts}
        values($1,$2,$3,$4,1,2,'after') on conflict(learner_id,app_id,release_id,to_version) do nothing returning id`,
      [receipt,learner,app,release]);
      if(inserted.rowCount===1)await client.query(`update ${progress} set schema_version=2,state_json='{"currentLevel":"one"}',
        state_hash='after',last_receipt_id=$3 where learner_id=$1 and app_id=$2 and schema_version=1 and progress_version=7`,
      [learner,app,receipt]);
      await client.query("commit");return inserted.rowCount;
    }catch(error){await client.query("rollback");throw error}};
    const results=await Promise.all(clients.map(migrate));expect(results.sort()).toEqual([0,1]);
    expect((await clients[0].query(`select schema_version,state_json,state_hash from ${progress} where learner_id=$1`,[learner])).rows[0])
      .toEqual({schema_version:2,state_json:{currentLevel:"one"},state_hash:"after"});
    expect((await clients[0].query(`select count(*)::int n from ${receipts} where learner_id=$1`,[learner])).rows[0].n).toBe(1);
  });

  it("rolls back migration evidence when the state update fails",async()=>{
    const learner=randomUUID(),app=randomUUID(),release=randomUUID();
    await clients[0].query(`insert into ${progress} values($1,$2,1,1,'{}','before',null)`,[learner,app]);
    await clients[0].query("begin");
    await clients[0].query(`insert into ${receipts} values($1,$2,$3,$4,1,2,'after')`,[randomUUID(),learner,app,release]);
    await expect(clients[0].query(`update ${progress} set schema_version=null where learner_id=$1`,[learner]))
      .rejects.toThrow(/null value/);
    await clients[0].query("rollback");
    expect((await clients[0].query(`select schema_version,state_hash from ${progress} where learner_id=$1`,[learner])).rows[0])
      .toEqual({schema_version:1,state_hash:"before"});
    expect((await clients[0].query(`select count(*)::int n from ${receipts} where learner_id=$1`,[learner])).rows[0].n).toBe(0);
  });

  it("enforces immutable transforms and receipts on the deployed tables",async()=>{
    const triggers=await clients[0].query(`select tgname from pg_trigger where not tgisinternal and tgrelid in
      ('app_progress_schema_migrations'::regclass,'learner_progress_migration_receipts'::regclass)`);
    expect(triggers.rows.map(row=>row.tgname).sort()).toEqual([
      "app_progress_schema_migrations_no_delete","app_progress_schema_migrations_no_update",
      "learner_progress_migration_receipts_no_delete","learner_progress_migration_receipts_no_update"
    ]);
  });
});
