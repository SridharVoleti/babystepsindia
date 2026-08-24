// @vitest-environment node
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";

const live=process.env.RUN_SUPABASE_ACCEPTANCE==="1"?describe:describe.skip;
live("PR-003 staging Postgres summary certification",()=>{
  const clients=[0,1].map(()=>new Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}}));
  const table=`pr003_summary_${randomUUID().replaceAll("-","")}`;
  beforeAll(async()=>{await Promise.all(clients.map(client=>client.connect()));await clients[0].query(`create table ${table}(
    learner_id uuid,app_id uuid,progress_version int not null,state_hash text not null,state_json jsonb not null,
    current_level text,current_lesson text,summary_json jsonb,summary_version int not null,summary_based_on int,
    visibility text not null,primary key(learner_id,app_id))`)});
  afterAll(async()=>{await clients[0].query(`drop table if exists ${table}`);await Promise.all(clients.map(client=>client.end()))});

  it("accepts one concurrent summary writer without changing progress authority",async()=>{
    const learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${table} values($1,$2,7,'authority','{"lesson":7}','L7','lesson-7',
      '{"currentLevel":"L7"}',1,7,'current')`,[learner,app]);
    const write=(client:Client,label:string)=>client.query(`update ${table} set summary_json=$3,summary_version=2,
      summary_based_on=7,visibility='current' where learner_id=$1 and app_id=$2 and progress_version=7 and summary_version=1`,
      [learner,app,{currentLevel:label}]);
    const results=await Promise.all([write(clients[0],"A"),write(clients[1],"B")]);
    expect(results.map(result=>result.rowCount).sort()).toEqual([0,1]);
    const row=(await clients[0].query(`select progress_version,state_hash,state_json,current_level,current_lesson,
      summary_version,summary_based_on from ${table} where learner_id=$1`,[learner])).rows[0];
    expect(row).toEqual({progress_version:7,state_hash:"authority",state_json:{lesson:7},current_level:"L7",
      current_lesson:"lesson-7",summary_version:2,summary_based_on:7});
  });

  it("rejects a stale based-on progress version without any mutation",async()=>{
    const learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${table} values($1,$2,9,'authority-9','{}',null,null,null,0,null,'current')`,[learner,app]);
    const result=await clients[0].query(`update ${table} set summary_json='{}',summary_version=1,summary_based_on=8
      where learner_id=$1 and app_id=$2 and progress_version=8 and summary_version=0`,[learner,app]);
    expect(result.rowCount).toBe(0);
    expect((await clients[0].query(`select progress_version,state_hash,summary_json from ${table} where learner_id=$1`,[learner])).rows[0])
      .toEqual({progress_version:9,state_hash:"authority-9",summary_json:null});
  });
});
