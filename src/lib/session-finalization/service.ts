import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
import type { ValidatedContribution } from "@/lib/analytics/validation";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate, splitKolkataEngagedSeconds } from "@/lib/analytics/kolkata-interval";
import type { AppProgressContext } from "@/lib/app-progress/service";
import { closeRecoveryWindow } from "@/lib/progress-recovery/service";

// applyDailyContribution now runs its own async DbClient transaction, which
// better-sqlite3 can't nest inside this file's still-synchronous legacy
// db.transaction() calls — finalizeCore builds the contribution inputs
// instead of applying them, so callers can apply them (sequentially, never
// Promise.all — see sqlite-adapter.ts) after their own transaction commits.
async function applyContributions(contributions: ValidatedContribution[]): Promise<void> {
  for (const contribution of contributions) await applyDailyContribution(contribution);
}

export class SessionFinalizationError extends Error {
  constructor(public readonly code:string){super(code);this.name="SessionFinalizationError";}
}
const reasons=new Set(["learner_finished","no_more_eligible_work","voluntary_early_exit","intentional_finish"]);
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const RETURN_URL="/learning-session/return";
type Session={id:string;learner_id:string;app_id:string;parent_user_id:string;status:string;version:number;
 connected_elapsed_seconds:number;verified_active_seconds:number;maximum_connected_seconds:number;
 usable_launch_established_at:string|null;active_segment_started_at:string|null;
 end_reason:string|null;ended_at:string|null;
 final_progress_version:number|null;current_level_key:string|null;resume_token_hash:string};

async function progressVersion(db:DbClient,session:Session){return Number((await db.get<
  {progress_version:number}>("select progress_version from learner_app_progress where learner_id=? and app_id=?",
  [session.learner_id,session.app_id]))?.progress_version??0);}

// PR-003/GAP-062: finalization surfaces whatever standardized progress
// summary the app last acknowledged via saveCheckpoint/completeLesson —
// null if the app never supplied one, not a hard block on finalizing.
async function finalProgressSummary(db:DbClient,session:Session){const row=await db.get<{progress_summary_json:string|null}>(
  "select progress_summary_json from learner_app_progress where learner_id=? and app_id=?",
  [session.learner_id,session.app_id]);
 return row?.progress_summary_json?JSON.parse(row.progress_summary_json):null;}

async function response(db:DbClient,session:Session){return {sessionId:session.id,status:session.status,endReasonCode:session.end_reason,
  finalProgressVersion:session.final_progress_version,connectedElapsedSeconds:session.connected_elapsed_seconds,
  verifiedActiveSeconds:session.verified_active_seconds,finalProgressSummary:await finalProgressSummary(db,session),returnUrl:RETURN_URL};}

function acceptFinalConnectedSeconds(session:Session,reportedConnectedSeconds:number|undefined,now:Date){
 if(["disconnected","resumable"].includes(session.status))return session.connected_elapsed_seconds;
 const reported=Math.max(0,Math.floor(reportedConnectedSeconds??session.connected_elapsed_seconds));
 const wallClockCap=session.usable_launch_established_at
  ?Math.max(0,Math.floor((now.getTime()-new Date(session.usable_launch_established_at).getTime())/1000))
  :session.maximum_connected_seconds;
 return Math.max(session.connected_elapsed_seconds,Math.min(reported,session.maximum_connected_seconds,wallClockCap));
}

async function finalizeCore(db:DbClient,session:Session,reason:string,finalProgressVersion:number,now:Date,reportedConnectedSeconds?:number):
  Promise<{ session: Session; contributions: ValidatedContribution[] }> {
 const timestamp=now.toISOString();
 const contributions: ValidatedContribution[] = [];
 // SC-001 business rule 19 / AN-001 AC7/27: the app supplies a cumulative
 // final report, but the platform accepts no more than the fixed session
 // maximum or server-observed wall-clock time. A prior disconnect checkpoint
 // is the floor, so finalization can never move accepted time backwards.
 const finalReported=Math.max(0,Math.floor(reportedConnectedSeconds??session.connected_elapsed_seconds));
 const connected=acceptFinalConnectedSeconds(session,reportedConnectedSeconds,now);
 const engagedDelta=connected-session.connected_elapsed_seconds;
 const finalizedWrite=await db.run(`update learner_sessions set status='completed',end_reason=?,ended_at=?,final_progress_version=?,
   finalization_started_at=?,connected_elapsed_seconds=?,final_reported_connected_seconds=?,
   final_accepted_connected_seconds=?,verified_active_seconds=?,resume_token_hash='',disconnected_at=null,resume_deadline=null,
   active_segment_started_at=null,intentional_exit_state=case when ?='intentional_finish' then 'finalized' else intentional_exit_state end,
   intentional_exit_reason=case when ?='intentional_finish' then 'intentional_finish' else intentional_exit_reason end,
   exit_transition_version=exit_transition_version+case when ?='intentional_finish' then 1 else 0 end,
   version=version+1,updated_at=? where id=? and status in ('active','disconnected','resumable')`,
  [reason,timestamp,finalProgressVersion,timestamp,connected,finalReported,connected,connected,
    reason,reason,reason,timestamp,session.id]);
 if(finalizedWrite.changes!==1)throw new SessionFinalizationError("LEARNER_SESSION_FINALIZATION_RACE");
 await db.run(`update app_session_grants set status='revoked',grant_version=grant_version+1,
   revocation_reason='session_finalized',revoked_at=?,updated_at=? where learner_session_id=? and status='active'`,
  [timestamp,timestamp,session.id]);
 await db.run("update learner_session_launch_state set status='revoked',code_hash=null,code_expires_at=null,updated_at=? where learner_session_id=?",
  [timestamp,session.id]);
 const learner=(await db.get<{date_of_birth:string}>("select date_of_birth from learners where id=?",[session.learner_id]))!;
 const activityDate=kolkataCalendarDate(now);
 const common={learnerId:session.learner_id,appId:session.app_id,levelKey:session.current_level_key??"unassigned"};
 contributions.push({contributionId:`session-completed:${session.id}`,activityDate,...common,
   ageBand:deriveAgeBand(learner.date_of_birth,activityDate),deltas:{engagedSeconds:0,sessionsStarted:0,
    sessionsCompleted:1,sessionsInterrupted:0,lessonsCompleted:0}});
 if(engagedDelta>0){
  const segmentStart=session.active_segment_started_at?new Date(session.active_segment_started_at)
   :new Date(now.getTime()-engagedDelta*1000);
  for(const chunk of splitKolkataEngagedSeconds(segmentStart,engagedDelta)){
   contributions.push({contributionId:`session-completed:${session.id}:engaged:${chunk.activityDate}`,
    activityDate:chunk.activityDate,...common,ageBand:deriveAgeBand(learner.date_of_birth,chunk.activityDate),
    deltas:{engagedSeconds:chunk.engagedSeconds,sessionsStarted:0,sessionsCompleted:0,sessionsInterrupted:0,lessonsCompleted:0}});
  }
 }
 await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_session_finalized',?)",
  [randomUUID(),session.parent_user_id,JSON.stringify({sessionId:session.id,appId:session.app_id,reason,
    finalProgressVersion,connectedElapsedSeconds:connected})]);
 await closeRecoveryWindow(session.id,"finalized",now);
 return { session: (await db.get<Session>("select * from learner_sessions where id=?",[session.id]))!, contributions };
}

export async function finalizeLearnerSession(context:AppProgressContext,input:{expectedSessionVersion:number;
 finalProgressVersion:number;endReasonCode:string;completionIdempotencyKey:string;reportedConnectedSeconds:number},now:Date){
 if(!reasons.has(input.endReasonCode))throw new SessionFinalizationError("SESSION_END_REASON_INVALID");
 if(!Number.isFinite(input.reportedConnectedSeconds))throw new SessionFinalizationError("SESSION_CONNECTED_SECONDS_INVALID");
 const db=resolveDbClient(); const requestHash=hash(input);
 const existing=await db.get<{request_hash:string;response_json:string}>(`select request_hash,response_json from session_finalization_requests
  where learner_session_id=? and app_principal_id=? and idempotency_key=?`,[context.learnerSessionId,context.principalId,
  input.completionIdempotencyKey]);
 if(existing){if(existing.request_hash!==requestHash)throw new SessionFinalizationError("IDEMPOTENCY_KEY_REUSED");return JSON.parse(existing.response_json);}
 let committed: { result: Awaited<ReturnType<typeof response>>; contributions: ValidatedContribution[] };
 try { committed = await resolveDbClient().transaction(async (db)=>{
  const transactionReplay=await db.get<{request_hash:string;response_json:string}>(`select request_hash,response_json from session_finalization_requests
   where learner_session_id=? and app_principal_id=? and idempotency_key=?`,[context.learnerSessionId,context.principalId,
   input.completionIdempotencyKey]);
  if(transactionReplay){if(transactionReplay.request_hash!==requestHash)throw new SessionFinalizationError("IDEMPOTENCY_KEY_REUSED");
   return {result:JSON.parse(transactionReplay.response_json),contributions:[] as ValidatedContribution[]};}
  const session=await db.get<Session>("select * from learner_sessions where id=?",[context.learnerSessionId]);
  if(!session||session.learner_id!==context.learnerId||session.app_id!==context.appId)throw new SessionFinalizationError("LEARNER_SESSION_BINDING_MISMATCH");
  if(!["active","disconnected","resumable"].includes(session.status))throw new SessionFinalizationError("LEARNER_SESSION_NOT_COMPLETABLE");
  if(session.version!==input.expectedSessionVersion)throw new SessionFinalizationError("LEARNER_SESSION_VERSION_CONFLICT");
  if(await progressVersion(db,session)!==input.finalProgressVersion)throw new SessionFinalizationError("FINAL_PROGRESS_NOT_ACKNOWLEDGED");
  const finalized=await finalizeCore(db,session,input.endReasonCode,input.finalProgressVersion,now,input.reportedConnectedSeconds);
  const result=await response(db,finalized.session);
  await db.run(`insert into session_finalization_requests(learner_session_id,app_principal_id,idempotency_key,
   request_hash,response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`,[session.id,context.principalId,
   input.completionIdempotencyKey,requestHash,JSON.stringify(result),new Date(now.getTime()+7*86400_000).toISOString(),now.toISOString()]);
  return { result, contributions: finalized.contributions };
 }); } catch(error) {
  if(error instanceof SessionFinalizationError&&error.code==="LEARNER_SESSION_FINALIZATION_RACE"){
   const replay=await resolveDbClient().get<{request_hash:string;response_json:string}>(`select request_hash,response_json from session_finalization_requests
    where learner_session_id=? and app_principal_id=? and idempotency_key=?`,[context.learnerSessionId,context.principalId,
    input.completionIdempotencyKey]);
   if(replay&&replay.request_hash===requestHash)return JSON.parse(replay.response_json);
  }
  throw error;
 }
 await applyContributions(committed.contributions);
 return committed.result;
}

export async function finalizeSessionAutomatically(sessionId:string,reason:"time_limit_reached",now:Date){
 let committed: { result: Awaited<ReturnType<typeof response>>; contributions: ValidatedContribution[] };
 try { committed = await resolveDbClient().transaction(async (db)=>{const session=await db.get<Session>(
   "select * from learner_sessions where id=?",[sessionId]);
  if(!session)throw new SessionFinalizationError("LEARNER_SESSION_NOT_FOUND");
  if(session.status==="completed")return { result: await response(db,session), contributions: [] as ValidatedContribution[] };
  if(!["active","disconnected","resumable"].includes(session.status))throw new SessionFinalizationError("LEARNER_SESSION_NOT_COMPLETABLE");
  const finalized=await finalizeCore(db,session,reason,await progressVersion(db,session),now);
  return { result: await response(db,finalized.session), contributions: finalized.contributions };}); }
 catch(error){
  if(error instanceof SessionFinalizationError&&error.code==="LEARNER_SESSION_FINALIZATION_RACE"){
   const session=await resolveDbClient().get<Session>("select * from learner_sessions where id=?",[sessionId]);
   if(session?.status==="completed")return response(resolveDbClient(),session);
  }
  throw error;
 }
 await applyContributions(committed.contributions);
 return committed.result;
}

export async function purgeSessionFinalizationReceipts(now:Date){return (await resolveDbClient().run(
 "delete from session_finalization_requests where expires_at<=?",[now.toISOString()])).changes;}
