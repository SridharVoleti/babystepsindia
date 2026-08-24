// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const live = process.env.RUN_SUPABASE_ACCEPTANCE === "1" ? describe : describe.skip;

live("LA-003/LA-004 staging Supabase/Postgres lifecycle certification", () => {
  const clients=[0,1,2].map(()=>new Client({connectionString:process.env.SUPABASE_DB_URL,
    ssl:{rejectUnauthorized:false}}));
  const suffix=randomUUID().replaceAll("-","");
  const progress=`la003_progress_${suffix}`, completions=`la003_completion_${suffix}`;
  const sessions=`la004_session_${suffix}`, credits=`la004_credit_${suffix}`;

  beforeAll(async()=>{
    await Promise.all(clients.map((client)=>client.connect()));
    await clients[0].query(`create table ${progress}(learner_id uuid not null,app_id uuid not null,
      progress_version integer not null,state text not null,primary key(learner_id,app_id))`);
    await clients[0].query(`create table ${completions}(learner_id uuid not null,app_id uuid not null,
      lesson_key text not null,primary key(learner_id,app_id,lesson_key))`);
    await clients[0].query(`create table ${sessions}(id uuid primary key,status text not null,version integer not null)`);
    await clients[0].query(`create table ${credits}(id uuid primary key,source_session_id uuid not null unique,status text not null)`);
  });

  afterAll(async()=>{
    for(const table of [credits,sessions,completions,progress])await clients[0].query(`drop table if exists ${table}`);
    await Promise.all(clients.map((client)=>client.end()));
  });

  it("preserves one progress row and admits one writer for an expected version",async()=>{
    const learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${progress} values($1,$2,0,'initial')`,[learner,app]);
    const write=(client:Client,state:string)=>client.query(`update ${progress} set progress_version=1,state=$3
      where learner_id=$1 and app_id=$2 and progress_version=0 returning progress_version`,[learner,app,state]);
    const results=await Promise.all([write(clients[0],"a"),write(clients[1],"b")]);
    expect(results.map((result)=>result.rowCount).sort()).toEqual([0,1]);
    expect((await clients[2].query(`select count(*)::int n,max(progress_version)::int v from ${progress}`)).rows[0])
      .toMatchObject({n:1,v:1});
  });

  it("records the first lesson completion exactly once under concurrency",async()=>{
    const learner=randomUUID(),app=randomUUID();
    const complete=(client:Client)=>client.query(`insert into ${completions} values($1,$2,'lesson-1')
      on conflict(learner_id,app_id,lesson_key) do nothing returning lesson_key`,[learner,app]);
    const results=await Promise.all([complete(clients[0]),complete(clients[1])]);
    expect(results.map((result)=>result.rowCount).sort()).toEqual([0,1]);
  });

  it("allows one finalizer and one technical replacement credit",async()=>{
    const sessionId=randomUUID();
    await clients[0].query(`insert into ${sessions} values($1,'active',1)`,[sessionId]);
    const finalize=(client:Client)=>client.query(`update ${sessions} set status='completed',version=version+1
      where id=$1 and status='active' and version=1 returning status`,[sessionId]);
    const finalizations=await Promise.all([finalize(clients[0]),finalize(clients[1])]);
    expect(finalizations.map((result)=>result.rowCount).sort()).toEqual([0,1]);
    const credit=(client:Client)=>client.query(`insert into ${credits} values($1,$2,'available')
      on conflict(source_session_id) do nothing returning id`,[randomUUID(),sessionId]);
    const replacements=await Promise.all([credit(clients[0]),credit(clients[1])]);
    expect(replacements.map((result)=>result.rowCount).sort()).toEqual([0,1]);
  });

  it("forces RLS on every LA-003/LA-004 server-only table",async()=>{
    const names=["learner_app_progress","progress_mutation_requests","lesson_completions",
      "session_finalization_requests","learner_session_credits","technical_credit_claim_requests",
      "learner_sessions","progress_recovery_receipts"];
    const result=await clients[0].query(`select relname,relrowsecurity,relforcerowsecurity from pg_class
      where relname=any($1::text[])`,[names]);
    expect(result.rows).toHaveLength(names.length);
    for(const row of result.rows)expect(row).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
  });
});
