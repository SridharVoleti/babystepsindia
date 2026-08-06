import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

export class SessionCreditError extends Error{constructor(public readonly code:string){super(code);this.name="SessionCreditError";}}
type Actor={actorType:"learner"|"parent";actorId:string};
type Credit={id:string;source_learner_session_id:string;learner_id:string;app_id:string;status:string;granted_at:string;
 expires_at:string;reserved_session_id:string|null;version:number};
const requestHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
function addCalendarMonth(date:Date){const year=date.getUTCFullYear(),month=date.getUTCMonth(),day=date.getUTCDate();
 const last=new Date(Date.UTC(year,month+2,0)).getUTCDate();return new Date(Date.UTC(year,month+1,Math.min(day,last),
  date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds(),date.getUTCMilliseconds()));}
function view(row:Credit){return {creditId:row.id,sourceSessionId:row.source_learner_session_id,learnerId:row.learner_id,
 appId:row.app_id,status:row.status,grantedAt:row.granted_at,expiresAt:row.expires_at};}
function authorize(actor:Actor,session:{learner_id:string;parent_user_id:string}){
 if((actor.actorType==="parent"&&actor.actorId!==session.parent_user_id)||(actor.actorType==="learner"&&actor.actorId!==session.learner_id))
  throw new SessionCreditError("LEARNER_SESSION_BINDING_MISMATCH");}

export function claimTechnicalCredit(actor:Actor,sessionId:string,input:{confirmation:boolean;idempotencyKey:string},now:Date){
 if(input.confirmation!==true)throw new SessionCreditError("TECHNICAL_CREDIT_NOT_ELIGIBLE");const db=getDb();const hash=requestHash(input);
 const receipt=db.prepare(`select request_hash,response_json from technical_credit_claim_requests
  where actor_id=? and source_learner_session_id=? and idempotency_key=?`).get(actor.actorId,sessionId,input.idempotencyKey) as
  {request_hash:string;response_json:string}|undefined;
 if(receipt){if(receipt.request_hash!==hash)throw new SessionCreditError("IDEMPOTENCY_KEY_REUSED");return JSON.parse(receipt.response_json);}
 return db.transaction(()=>{const session=db.prepare("select * from learner_sessions where id=?").get(sessionId) as
  {id:string;learner_id:string;app_id:string;parent_user_id:string;status:string;ended_at:string|null}|undefined;
  if(!session)throw new SessionCreditError("TECHNICAL_CREDIT_NOT_ELIGIBLE");authorize(actor,session);
  if(!session.ended_at||!["completed","interrupted","expired","revoked_by_admin"].includes(session.status))
   throw new SessionCreditError("TECHNICAL_CREDIT_NOT_ELIGIBLE");
  if(now.getTime()>new Date(session.ended_at).getTime()+7*86400_000)throw new SessionCreditError("TECHNICAL_CREDIT_CLAIM_EXPIRED");
  let credit=db.prepare("select * from learner_session_credits where source_learner_session_id=? and credit_type='technical_replacement'")
   .get(sessionId) as Credit|undefined;
  if(!credit){const id=randomUUID(),timestamp=now.toISOString(),expires=addCalendarMonth(now).toISOString();
   db.prepare(`insert into learner_session_credits(id,source_learner_session_id,learner_id,app_id,credit_type,status,
    confirmed_by_actor_type,confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,created_at,updated_at)
    values(?,?,?,?,'technical_replacement','available',?,?,'technical_issue',?,?,?,?)`)
    .run(id,session.id,session.learner_id,session.app_id,actor.actorType,actor.actorId,timestamp,expires,timestamp,timestamp);
   credit=db.prepare("select * from learner_session_credits where id=?").get(id) as Credit;
   db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'technical_credit_granted',?)")
    .run(randomUUID(),session.parent_user_id,JSON.stringify({creditId:id,sourceSessionId:session.id,appId:session.app_id,expiresAt:expires}));}
  const result=view(credit);
  db.prepare(`insert into technical_credit_claim_requests(actor_id,source_learner_session_id,idempotency_key,request_hash,
   response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`).run(actor.actorId,sessionId,input.idempotencyKey,hash,
   JSON.stringify(result),new Date(now.getTime()+8*86400_000).toISOString(),now.toISOString());return result;})();
}

export function expireTechnicalCredits(now:Date){return getDb().prepare(`update learner_session_credits set status='expired',
 version=version+1,updated_at=? where status in ('available','reserved') and expires_at<=?`).run(now.toISOString(),now.toISOString()).changes;}
export function listTechnicalCredits(actor:Actor,learnerId:string,now:Date){const db=getDb();const learner=db.prepare(
 "select owner_parent_id from learners where id=?").get(learnerId) as {owner_parent_id:string}|undefined;
 if(!learner||(actor.actorType==="parent"?actor.actorId!==learner.owner_parent_id:actor.actorId!==learnerId))
  throw new SessionCreditError("LEARNER_SESSION_BINDING_MISMATCH");expireTechnicalCredits(now);
 return (db.prepare("select * from learner_session_credits where learner_id=? order by expires_at").all(learnerId) as Credit[]).map(view);}
export function reserveTechnicalCredit(creditId:string,learnerId:string,appId:string,reservedSessionId:string,now:Date){const db=getDb();
 return db.transaction(()=>{expireTechnicalCredits(now);const credit=db.prepare("select * from learner_session_credits where id=?").get(creditId) as Credit|undefined;
  if(!credit||credit.learner_id!==learnerId||credit.app_id!==appId)throw new SessionCreditError("SESSION_CREDIT_BINDING_MISMATCH");
  if(credit.status!=="available")throw new SessionCreditError(`SESSION_CREDIT_${credit.status.toUpperCase()}`);
  db.prepare("update learner_session_credits set status='reserved',reserved_session_id=?,reserved_at=?,version=version+1,updated_at=? where id=?")
   .run(reservedSessionId,now.toISOString(),now.toISOString(),creditId);return view(db.prepare("select * from learner_session_credits where id=?").get(creditId) as Credit);})();}
export function consumeTechnicalCredit(creditId:string,reservedSessionId:string,now:Date){const db=getDb();return db.transaction(()=>{
 const credit=db.prepare("select * from learner_session_credits where id=?").get(creditId) as Credit|undefined;
 if(!credit||credit.reserved_session_id!==reservedSessionId)throw new SessionCreditError("SESSION_CREDIT_BINDING_MISMATCH");
 if(now>=new Date(credit.expires_at)){db.prepare("update learner_session_credits set status='expired',version=version+1,updated_at=? where id=?")
  .run(now.toISOString(),creditId);throw new SessionCreditError("SESSION_CREDIT_EXPIRED");}
 if(credit.status==="consumed")return view(credit);if(credit.status!=="reserved")throw new SessionCreditError(`SESSION_CREDIT_${credit.status.toUpperCase()}`);
 db.prepare("update learner_session_credits set status='consumed',consumed_at=?,version=version+1,updated_at=? where id=?")
  .run(now.toISOString(),now.toISOString(),creditId);return view(db.prepare("select * from learner_session_credits where id=?").get(creditId) as Credit);})();}
export function restoreTechnicalCredit(creditId:string,reservedSessionId:string,now:Date){const db=getDb();const credit=db.prepare(
 "select * from learner_session_credits where id=?").get(creditId) as Credit|undefined;if(!credit||credit.reserved_session_id!==reservedSessionId||credit.status!=="reserved")return false;
 const status=now<new Date(credit.expires_at)?"available":"expired";db.prepare(`update learner_session_credits set status=?,reserved_session_id=null,
 reserved_at=null,version=version+1,updated_at=? where id=?`).run(status,now.toISOString(),creditId);return status==="available";}
export function purgeTechnicalCreditClaimReceipts(now:Date){return getDb().prepare(
 "delete from technical_credit_claim_requests where expires_at<=?").run(now.toISOString()).changes;}
