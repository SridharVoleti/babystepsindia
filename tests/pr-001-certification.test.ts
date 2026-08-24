import {beforeEach,describe,expect,it} from "vitest";
import {sqliteAuthAdapter} from "@/lib/auth/sqlite-auth-adapter";
import {getDb} from "@/lib/db/client";
import {useInMemoryDb} from "@/lib/db/test-utils";
import {createLearner} from "@/lib/db/learner-repo";
import {computeCanonicalStateHash} from "@/lib/progress-integrity/service";
import {migrateLearnerProgressToReleaseSchema,ProgressSchemaRegistryError,registerProgressSchema,
  registerSchemaMigration} from "@/lib/progress-schema-registry/service";

const now=new Date("2026-08-24T10:00:00Z"),appId="10000000-0000-4000-8000-000000000055",
  releaseId="20000000-0000-4000-8000-000000000055",environment="production";
let learnerId:string;

beforeEach(async()=>{
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status) values(?,?,'PR App','active')`)
    .run(appId,"pr-app");
  const {user}=await sqliteAuthAdapter.signUp(`pr55-${crypto.randomUUID()}@example.com`,"CorrectHorse1!");
  learnerId=(await createLearner(user.id,{displayName:"Asha",dateOfBirth:"2018-01-01",
    idempotencyKey:crypto.randomUUID()},"2026-08-24")).learner.id;
  const state=JSON.stringify({level:"one",obsolete:true});
  const hash=computeCanonicalStateHash({learnerId,appId,environment,progressVersion:1,schemaVersion:1,serializedState:state});
  getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,
    progress_version,state_hash,updated_at) values(?,?,1,?,1,?,?)`).run(learnerId,appId,state,hash,now.toISOString());
  await registerProgressSchema({appId,releaseId:"baseline-release",schemaVersion:1,schemaJson:JSON.stringify({type:"object"}),now});
  await registerProgressSchema({appId,releaseId,schemaVersion:2,schemaJson:JSON.stringify({type:"object"}),now});
  await registerSchemaMigration({appId,fromSchemaVersion:1,toSchemaVersion:2,
    transform:{renameFields:{level:"currentLevel"},dropFields:["obsolete"],setDefaults:{stars:0}},now});
});

describe("PR-001 atomic migration certification",()=>{
  it("migrates exactly once with canonical hash and release/version evidence",async()=>{
    await migrateLearnerProgressToReleaseSchema({appId,learnerId,releaseId,environment,now});
    await migrateLearnerProgressToReleaseSchema({appId,learnerId,releaseId,environment,now});
    const row=getDb().prepare(`select schema_version,current_state_json,progress_version,state_hash,
      last_migration_receipt_id from learner_app_progress where learner_id=? and app_id=?`).get(learnerId,appId) as any;
    expect(JSON.parse(row.current_state_json)).toEqual({currentLevel:"one",stars:0});
    expect(row.schema_version).toBe(2);
    expect(row.state_hash).toBe(computeCanonicalStateHash({learnerId,appId,environment,progressVersion:1,
      schemaVersion:2,serializedState:row.current_state_json}));
    expect(getDb().prepare("select count(*) n from learner_progress_migration_receipts").get()).toMatchObject({n:1});
    expect(getDb().prepare(`select release_id,from_schema_version,to_schema_version,state_hash_after
      from learner_progress_migration_receipts where id=?`).get(row.last_migration_receipt_id))
      .toMatchObject({release_id:releaseId,from_schema_version:1,to_schema_version:2,state_hash_after:row.state_hash});
  });

  it("rolls back the receipt when the progress update fails",async()=>{
    getDb().exec(`create trigger reject_pr001_update before update on learner_app_progress
      begin select raise(abort,'simulated progress write failure'); end`);
    await expect(migrateLearnerProgressToReleaseSchema({appId,learnerId,releaseId,environment,now}))
      .rejects.toThrow(/simulated progress write failure/);
    expect(getDb().prepare("select schema_version,current_state_json from learner_app_progress").get())
      .toMatchObject({schema_version:1,current_state_json:JSON.stringify({level:"one",obsolete:true})});
    expect(getDb().prepare("select count(*) n from learner_progress_migration_receipts").get()).toMatchObject({n:0});
  });

  it("rejects replacement of a deployed transform and enforces database immutability",async()=>{
    await expect(registerSchemaMigration({appId,fromSchemaVersion:1,toSchemaVersion:2,
      transform:{setDefaults:{replacement:true}},now})).rejects
      .toThrowError(new ProgressSchemaRegistryError("SCHEMA_MIGRATION_IMMUTABLE"));
    expect(()=>getDb().prepare("update app_progress_schema_migrations set transform_json='{}'").run()).toThrow(/immutable/);
  });
});
