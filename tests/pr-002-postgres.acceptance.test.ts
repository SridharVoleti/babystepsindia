// @vitest-environment node
import {randomUUID} from "node:crypto";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {Client} from "pg";

const live=process.env.RUN_SUPABASE_ACCEPTANCE==="1"?describe:describe.skip;
live("PR-002 staging Postgres recovery certification",()=>{
  const clients=[0,1].map(()=>new Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}}));
  const suffix=randomUUID().replaceAll("-","");
  const progress=`pr002_progress_${suffix}`,receipts=`pr002_receipts_${suffix}`;
  beforeAll(async()=>{await Promise.all(clients.map(client=>client.connect()));await clients[0].query(`
    create table ${progress}(learner_id uuid,app_id uuid,progress_version int not null,state_hash text not null,
      state_json jsonb not null,session_ack_version int not null,credit_balance int not null,entitlement_state text not null,
      primary key(learner_id,app_id));
    create table ${receipts}(id uuid primary key,learner_id uuid,app_id uuid,idempotency_key text not null,
      result text not null,new_progress_version int,unique(learner_id,app_id,idempotency_key))`)});
  afterAll(async()=>{await clients[0].query(`drop table if exists ${receipts};drop table if exists ${progress}`);
    await Promise.all(clients.map(client=>client.end()))});

  it("allows one authoritative winner without changing credits or entitlement",async()=>{
    const learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${progress} values($1,$2,1,'base','{}',1,2,'active')`,[learner,app]);
    const recover=async(client:Client,key:string,state:string)=>{await client.query("begin");try{
      const updated=await client.query(`update ${progress} set progress_version=2,state_hash=$3,state_json=$4,session_ack_version=2
        where learner_id=$1 and app_id=$2 and progress_version=1 and state_hash='base'`,[learner,app,state,{state}]);
      if(updated.rowCount===1)await client.query(`insert into ${receipts} values($1,$2,$3,$4,'recovered',2)`,
        [randomUUID(),learner,app,key]);
      await client.query("commit");return updated.rowCount;
    }catch(error){await client.query("rollback");throw error}};
    expect((await Promise.all([recover(clients[0],"a","winner-a"),recover(clients[1],"b","winner-b")])).sort()).toEqual([0,1]);
    const row=(await clients[0].query(`select progress_version,session_ack_version,credit_balance,entitlement_state
      from ${progress} where learner_id=$1`,[learner])).rows[0];
    expect(row).toEqual({progress_version:2,session_ack_version:2,credit_balance:2,entitlement_state:"active"});
    expect((await clients[0].query(`select count(*)::int n from ${receipts} where learner_id=$1`,[learner])).rows[0].n).toBe(1);
  });

  it("rolls back progress and session acknowledgment when receipt persistence fails",async()=>{
    const learner=randomUUID(),app=randomUUID();
    await clients[0].query(`insert into ${progress} values($1,$2,1,'base','{}',1,2,'active')`,[learner,app]);
    await clients[0].query(`create trigger reject_receipt before insert on ${receipts}
      for each row execute function reject_progress_migration_mutation()`);
    await clients[0].query("begin");
    await clients[0].query(`update ${progress} set progress_version=2,state_hash='after',session_ack_version=2 where learner_id=$1`,[learner]);
    await expect(clients[0].query(`insert into ${receipts} values($1,$2,$3,'failure','recovered',2)`,
      [randomUUID(),learner,app])).rejects.toThrow(/immutable/);
    await clients[0].query("rollback");
    expect((await clients[0].query(`select progress_version,state_hash,session_ack_version,credit_balance,entitlement_state
      from ${progress} where learner_id=$1`,[learner])).rows[0])
      .toEqual({progress_version:1,state_hash:"base",session_ack_version:1,credit_balance:2,entitlement_state:"active"});
    await clients[0].query(`drop trigger reject_receipt on ${receipts}`);
  });

  it("has deployed failure categories and immutable recovery receipts",async()=>{
    const constraint=(await clients[0].query(`select pg_get_constraintdef(oid) definition from pg_constraint
      where conrelid='progress_recovery_incidents'::regclass and conname='progress_recovery_incidents_category_check'`)).rows[0];
    expect(constraint.definition).toContain("corrupted_capsule");expect(constraint.definition).toContain("expired");
    const triggers=(await clients[0].query(`select tgname from pg_trigger where tgrelid='progress_recovery_receipts'::regclass
      and not tgisinternal`)).rows.map(row=>row.tgname).sort();
    expect(triggers).toEqual(["progress_recovery_receipts_no_delete","progress_recovery_receipts_no_update"]);
  });
});
