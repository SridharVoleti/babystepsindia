import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate, splitKolkataEngagedSeconds } from "@/lib/analytics/kolkata-interval";
import type { AppProgressContext } from "@/lib/app-progress/service";
import { closeRecoveryWindow } from "@/lib/progress-recovery/service";

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

function progressVersion(session:Session){return Number((getDb().prepare(
  "select progress_version from learner_app_progress where learner_id=? and app_id=?").get(session.learner_id,session.app_id) as
  {progress_version:number}|undefined)?.progress_version??0);}

// PR-003/GAP-062: finalization surfaces whatever standardized progress
// summary the app last acknowledged via saveCheckpoint/completeLesson —
// null if the app never supplied one, not a hard block on finalizing.
function finalProgressSummary(session:Session){const row=getDb().prepare(
  "select progress_summary_json from learner_app_progress where learner_id=? and app_id=?")
  .get(session.learner_id,session.app_id) as {progress_summary_json:string|null}|undefined;
 return row?.progress_summary_json?JSON.parse(row.progress_summary_json):null;}

function response(session:Session){return {sessionId:session.id,status:session.status,endReasonCode:session.end_reason,
  finalProgressVersion:session.final_progress_version,connectedElapsedSeconds:session.connected_elapsed_seconds,
  verifiedActiveSeconds:session.verified_active_seconds,finalProgressSummary:finalProgressSummary(session),returnUrl:RETURN_URL};}

function acceptFinalConnectedSeconds(session:Session,reportedConnectedSeconds:number|undefined,now:Date){
 if(["disconnected","resumable"].includes(session.status))return session.connected_elapsed_seconds;
 const reported=Math.max(0,Math.floor(reportedConnectedSeconds??session.connected_elapsed_seconds));
 const wallClockCap=session.usable_launch_established_at
  ?Math.max(0,Math.floor((now.getTime()-new Date(session.usable_launch_established_at).getTime())/1000))
  :session.maximum_connected_seconds;
 return Math.max(session.connected_elapsed_seconds,Math.min(reported,session.maximum_connected_seconds,wallClockCap));
}

function finalizeCore(session:Session,reason:string,finalProgressVersion:number,now:Date,reportedConnectedSeconds?:number){
 const db=getDb(); const timestamp=now.toISOString();
 // SC-001 business rule 19 / AN-001 AC7/27: the app supplies a cumulative
 // final report, but the platform accepts no more than the fixed session
 // maximum or server-observed wall-clock time. A prior disconnect checkpoint
 // is the floor, so finalization can never move accepted time backwards.
 const finalReported=Math.max(0,Math.floor(reportedConnectedSeconds??session.connected_elapsed_seconds));
 const connected=acceptFinalConnectedSeconds(session,reportedConnectedSeconds,now);
 const engagedDelta=connected-session.connected_elapsed_seconds;
 db.prepare(`update learner_sessions set status='completed',end_reason=?,ended_at=?,final_progress_version=?,
   finalization_started_at=?,connected_elapsed_seconds=?,final_reported_connected_seconds=?,
   final_accepted_connected_seconds=?,verified_active_seconds=?,resume_token_hash='',disconnected_at=null,resume_deadline=null,
   active_segment_started_at=null,intentional_exit_state=case when ?='intentional_finish' then 'finalized' else intentional_exit_state end,
   intentional_exit_reason=case when ?='intentional_finish' then 'intentional_finish' else intentional_exit_reason end,
   exit_transition_version=exit_transition_version+case when ?='intentional_finish' then 1 else 0 end,
   version=version+1,updated_at=? where id=? and status in ('active','disconnected','resumable')`)
  .run(reason,timestamp,finalProgressVersion,timestamp,connected,finalReported,connected,connected,
    reason,reason,reason,timestamp,session.id);
 db.prepare(`update app_session_grants set status='revoked',grant_version=grant_version+1,
   revocation_reason='session_finalized',revoked_at=?,updated_at=? where learner_session_id=? and status='active'`)
  .run(timestamp,timestamp,session.id);
 db.prepare("update learner_session_launch_state set status='revoked',code_hash=null,code_expires_at=null,updated_at=? where learner_session_id=?")
  .run(timestamp,session.id);
 const learner=db.prepare("select date_of_birth from learners where id=?").get(session.learner_id) as {date_of_birth:string};
 const activityDate=kolkataCalendarDate(now);
 const common={learnerId:session.learner_id,appId:session.app_id,levelKey:session.current_level_key??"unassigned"};
 applyDailyContribution({contributionId:`session-completed:${session.id}`,activityDate,...common,
   ageBand:deriveAgeBand(learner.date_of_birth,activityDate),deltas:{engagedSeconds:0,sessionsStarted:0,
    sessionsCompleted:1,sessionsInterrupted:0,lessonsCompleted:0}});
 if(engagedDelta>0){
  const segmentStart=session.active_segment_started_at?new Date(session.active_segment_started_at)
   :new Date(now.getTime()-engagedDelta*1000);
  for(const chunk of splitKolkataEngagedSeconds(segmentStart,engagedDelta)){
   applyDailyContribution({contributionId:`session-completed:${session.id}:engaged:${chunk.activityDate}`,
    activityDate:chunk.activityDate,...common,ageBand:deriveAgeBand(learner.date_of_birth,chunk.activityDate),
    deltas:{engagedSeconds:chunk.engagedSeconds,sessionsStarted:0,sessionsCompleted:0,sessionsInterrupted:0,lessonsCompleted:0}});
  }
 }
 db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_session_finalized',?)")
  .run(randomUUID(),session.parent_user_id,JSON.stringify({sessionId:session.id,appId:session.app_id,reason,
    finalProgressVersion,connectedElapsedSeconds:connected}));
 closeRecoveryWindow(session.id,"finalized",now);
 return db.prepare("select * from learner_sessions where id=?").get(session.id) as Session;
}

export function finalizeLearnerSession(context:AppProgressContext,input:{expectedSessionVersion:number;
 finalProgressVersion:number;endReasonCode:string;completionIdempotencyKey:string;reportedConnectedSeconds:number},now:Date){
 if(!reasons.has(input.endReasonCode))throw new SessionFinalizationError("SESSION_END_REASON_INVALID");
 if(!Number.isFinite(input.reportedConnectedSeconds))throw new SessionFinalizationError("SESSION_CONNECTED_SECONDS_INVALID");
 const db=getDb(); const requestHash=hash(input);
 const existing=db.prepare(`select request_hash,response_json from session_finalization_requests
  where learner_session_id=? and app_principal_id=? and idempotency_key=?`).get(context.learnerSessionId,context.principalId,
  input.completionIdempotencyKey) as {request_hash:string;response_json:string}|undefined;
 if(existing){if(existing.request_hash!==requestHash)throw new SessionFinalizationError("IDEMPOTENCY_KEY_REUSED");return JSON.parse(existing.response_json);}
 return db.transaction(()=>{
  const session=db.prepare("select * from learner_sessions where id=?").get(context.learnerSessionId) as Session|undefined;
  if(!session||session.learner_id!==context.learnerId||session.app_id!==context.appId)throw new SessionFinalizationError("LEARNER_SESSION_BINDING_MISMATCH");
  if(!["active","disconnected","resumable"].includes(session.status))throw new SessionFinalizationError("LEARNER_SESSION_NOT_COMPLETABLE");
  if(session.version!==input.expectedSessionVersion)throw new SessionFinalizationError("LEARNER_SESSION_VERSION_CONFLICT");
  if(progressVersion(session)!==input.finalProgressVersion)throw new SessionFinalizationError("FINAL_PROGRESS_NOT_ACKNOWLEDGED");
  const finalized=finalizeCore(session,input.endReasonCode,input.finalProgressVersion,now,input.reportedConnectedSeconds);const result=response(finalized);
  db.prepare(`insert into session_finalization_requests(learner_session_id,app_principal_id,idempotency_key,
   request_hash,response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`).run(session.id,context.principalId,
   input.completionIdempotencyKey,requestHash,JSON.stringify(result),new Date(now.getTime()+7*86400_000).toISOString(),now.toISOString());
  return result;
 })();
}

export function finalizeSessionAutomatically(sessionId:string,reason:"time_limit_reached",now:Date){
 const db=getDb(); return db.transaction(()=>{const session=db.prepare("select * from learner_sessions where id=?").get(sessionId) as Session|undefined;
  if(!session)throw new SessionFinalizationError("LEARNER_SESSION_NOT_FOUND");
  if(session.status==="completed")return response(session);
  if(!["active","disconnected","resumable"].includes(session.status))throw new SessionFinalizationError("LEARNER_SESSION_NOT_COMPLETABLE");
  return response(finalizeCore(session,reason,progressVersion(session),now));})();
}

export function purgeSessionFinalizationReceipts(now:Date){return getDb().prepare(
 "delete from session_finalization_requests where expires_at<=?").run(now.toISOString()).changes;}
