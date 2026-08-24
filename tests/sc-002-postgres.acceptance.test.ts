// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live=process.env.RUN_SUPABASE_ACCEPTANCE==="1"?describe:describe.skip;

live("SC-002 staging Postgres atomic credit and pacing certification",()=>{
  const clients=Array.from({length:10},()=>new Client({connectionString:process.env.SUPABASE_DB_URL,
    ssl:{rejectUnauthorized:false}}));
  const suffix=randomUUID().replaceAll("-","");
  const batches=`sc002_batches_${suffix}`,usage=`sc002_usage_${suffix}`,receipts=`sc002_receipts_${suffix}`;
  beforeAll(async()=>{
    await Promise.all(clients.map((client)=>client.connect()));
    await clients[0].query(`create table ${batches}(id uuid primary key,learner_id uuid not null,app_id uuid not null,
      granted_count int not null check(granted_count=8),reserved_count int not null default 0,
      consumed_count int not null default 0,expires_at timestamptz not null,
      check(reserved_count>=0 and consumed_count>=0 and reserved_count+consumed_count<=granted_count));
      create table ${usage}(learner_id uuid,app_id uuid,week_key text,standard_sessions_funded int not null default 0
        check(standard_sessions_funded between 0 and 3),primary key(learner_id,app_id,week_key));
      create table ${receipts}(request_key text primary key,batch_id uuid not null,response_json jsonb not null)`);
  });
  afterAll(async()=>{
    await clients[0].query(`drop table if exists ${receipts};drop table if exists ${usage};drop table if exists ${batches}`);
    await Promise.all(clients.map((client)=>client.end()));
  });

  it("allows exactly eight concurrent reservations from an eight-credit batch",async()=>{
    const batch=randomUUID(),learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${batches}(id,learner_id,app_id,granted_count,expires_at)
      values($1,$2,$3,8,now()+interval '2 months')`,[batch,learner,app]);
    const attempts=await Promise.all(Array.from({length:10},(_,index)=>clients[index].query(
      `update ${batches} set reserved_count=reserved_count+1 where id=$1
       and granted_count-reserved_count-consumed_count>0 returning id`,[batch])));
    expect(attempts.filter((result)=>result.rowCount===1)).toHaveLength(8);
    expect((await clients[0].query(`select reserved_count,consumed_count from ${batches} where id=$1`,[batch])).rows[0])
      .toEqual({reserved_count:8,consumed_count:0});
  });

  it("consumes a reservation and weekly counter atomically",async()=>{
    const batch=randomUUID(),learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${batches} values($1,$2,$3,8,1,0,now()+interval '2 months')`,[batch,learner,app]);
    await clients[0].query(`insert into ${usage} values($1,$2,'2026-W35',0)`,[learner,app]);
    await clients[0].query("begin");
    await clients[0].query(`update ${batches} set reserved_count=reserved_count-1,consumed_count=consumed_count+1
      where id=$1 and reserved_count>0`,[batch]);
    await clients[0].query(`update ${usage} set standard_sessions_funded=standard_sessions_funded+1
      where learner_id=$1 and app_id=$2 and week_key='2026-W35' and standard_sessions_funded<3`,[learner,app]);
    await clients[0].query("commit");
    expect((await clients[0].query(`select reserved_count,consumed_count from ${batches} where id=$1`,[batch])).rows[0])
      .toEqual({reserved_count:0,consumed_count:1});
    expect((await clients[0].query(`select standard_sessions_funded from ${usage} where learner_id=$1`,[learner])).rows[0])
      .toEqual({standard_sessions_funded:1});
  });

  it("deduplicates usable-launch consumption and caps pacing at three",async()=>{
    const batch=randomUUID(),learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${batches} values($1,$2,$3,8,1,0,now()+interval '2 months')`,[batch,learner,app]);
    await clients[0].query(`insert into ${usage} values($1,$2,'2026-W36',2)`,[learner,app]);
    const confirm=async(key:string)=>clients[0].query(`insert into ${receipts}(request_key,batch_id,response_json)
      values($1,$2,'{"status":"consumed"}') on conflict(request_key) do nothing returning request_key`,[key,batch]);
    expect((await confirm("same-confirm")).rowCount).toBe(1);
    expect((await confirm("same-confirm")).rowCount).toBe(0);
    expect((await clients[0].query(`update ${usage} set standard_sessions_funded=standard_sessions_funded+1
      where learner_id=$1 and app_id=$2 and week_key='2026-W36' and standard_sessions_funded<3 returning *`,[learner,app])).rowCount).toBe(1);
    expect((await clients[0].query(`update ${usage} set standard_sessions_funded=standard_sessions_funded+1
      where learner_id=$1 and app_id=$2 and week_key='2026-W36' and standard_sessions_funded<3 returning *`,[learner,app])).rowCount).toBe(0);
  });

  it("confirms the deployed ledger tables are server-only with forced RLS",async()=>{
    const rows=(await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relnamespace='public'::regnamespace and relname in ('learner_app_standard_credit_batches','learner_app_week_usage')`)).rows;
    expect(rows).toHaveLength(2);expect(rows.every((row)=>row.relrowsecurity&&row.relforcerowsecurity)).toBe(true);
    const policies=(await clients[0].query(`select count(*)::int n from pg_policies where schemaname='public'
      and tablename in ('learner_app_standard_credit_batches','learner_app_week_usage')`)).rows[0];
    expect(policies.n).toBe(0);
  });
});
