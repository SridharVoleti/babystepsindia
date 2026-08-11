import {randomUUID} from "node:crypto";
import {getDb} from "@/lib/db/client";

export type AuthorizationMode="parent_management"|"learner_mode";
export const AUTHORIZATION_ACTIONS={
 "parent.account.read":{mode:"parent_management",resource:"parent"},
 "parent.account.security":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.security.read":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.email_change.cancel":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.email_change.request":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.email_change.resend":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.password.change":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.account.delete":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.billing.read":{mode:"parent_management",resource:"parent"},
 "parent.billing.checkout.create":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.billing.subscriptions.read":{mode:"parent_management",resource:"subscription"},
 "parent.billing.status.read":{mode:"parent_management",resource:"subscription"},
 "parent.billing.auto_renew.disable":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.billing.subscription.cancel":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.billing.auto_renew.resume":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.billing.payment_recovery.read":{mode:"parent_management",resource:"subscription"},
 "parent.billing.payment_method.update":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.billing.reassignment_case.create":{mode:"parent_management",resource:"subscription",sensitive:true},
 "parent.learners.list":{mode:"parent_management",resource:"learner"},
 "parent.learner.select":{mode:"parent_management",resource:"learner",sensitive:true},
 "parent.learner.read":{mode:"parent_management",resource:"learner"},
 "parent.learner.manage":{mode:"parent_management",resource:"learner",sensitive:true},
 "parent.learner.credits.read":{mode:"parent_management",resource:"learner"},
 "parent.learner.report.read":{mode:"parent_management",resource:"learner"},
 "parent.learner.past_apps.read":{mode:"parent_management",resource:"learner"},
 "parent.learner.subscribe_again.create":{mode:"parent_management",resource:"learner",sensitive:true},
 "parent.profile.read":{mode:"parent_management",resource:"parent"},
 "parent.profile.update":{mode:"parent_management",resource:"parent",sensitive:true},
 "parent.onboarding.ensure":{mode:"parent_management",resource:"parent"},
 "parent.passkeys.manage":{mode:"parent_management",resource:"credential",sensitive:true},
 "learner.mode.enter":{mode:"parent_management",resource:"learner",sensitive:true},
 "learner.home.read":{mode:"learner_mode",resource:"learner"},
 "learner.session.start":{mode:"learner_mode",resource:"learner",sensitive:true},
 "learner.session.resume":{mode:"learner_mode",resource:"learner",sensitive:true},
 "learner.technical_issue.confirm":{mode:"learner_mode",resource:"learner",sensitive:true},
 "learner.session.cancel_start":{mode:"learner_mode",resource:"learner",sensitive:true},
 "learner.mode.exit":{mode:"learner_mode",resource:"learner",sensitive:true},
 "admin.account.restore":{mode:"administrator",resource:"parent",sensitive:true},
 "admin.billing.reassignment_case.read":{mode:"administrator",resource:"subscription"},
 "admin.billing.subscription.reassign":{mode:"administrator",resource:"subscription",sensitive:true},
 "admin.analytics.daily.read":{mode:"administrator",resource:"analytics"},
 "admin.analytics.runs.read":{mode:"administrator",resource:"analytics"},
 "admin.analytics.run.retry":{mode:"administrator",resource:"analytics",sensitive:true},
 "admin.app.list":{mode:"administrator",resource:"app"},
 "admin.app.create":{mode:"administrator",resource:"app",sensitive:true},
 "admin.app.bootstrap":{mode:"administrator",resource:"app",sensitive:true},
 "admin.app.read":{mode:"administrator",resource:"app"},
 "admin.app.update":{mode:"administrator",resource:"app",sensitive:true},
 "admin.app.activate":{mode:"administrator",resource:"app",sensitive:true},
 "admin.app.restore":{mode:"administrator",resource:"app",sensitive:true},
 "admin.app.delete":{mode:"administrator",resource:"app",sensitive:true},
 "admin.deployment.bindings.read":{mode:"administrator",resource:"deployment"},
 "admin.deployment.bindings.create":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.bindings.update":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.bindings.verify":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.releases.read":{mode:"administrator",resource:"deployment"},
 "admin.deployment.release.deploy_staging":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.release.approve_production":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.deployments.read":{mode:"administrator",resource:"deployment"},
 "admin.deployment.windows.read":{mode:"administrator",resource:"deployment"},
 "admin.deployment.windows.schedule":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.windows.reschedule":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.windows.cancel":{mode:"administrator",resource:"deployment",sensitive:true},
 "admin.deployment.rollback":{mode:"administrator",resource:"deployment",sensitive:true},
 "service.deployment.release_create":{mode:"service",resource:"deployment",sensitive:true},
 "service.deployment.published.read":{mode:"service",resource:"deployment"},
 "service.deployment.safety_sweep":{mode:"service",resource:"deployment",sensitive:true},
 "service.deployment.window_sweep":{mode:"service",resource:"deployment",sensitive:true},
 "service.deployment.webhook_ingest":{mode:"service",resource:"deployment",sensitive:true},
 "service.deployment.retention_purge":{mode:"service",resource:"deployment",sensitive:true},
 "deployment.schedule":{mode:"administrator",resource:"deployment",sensitive:true},
 "deployment.reschedule":{mode:"administrator",resource:"deployment",sensitive:true},
 "deployment.cancel":{mode:"administrator",resource:"deployment",sensitive:true},
 "deployment.promote":{mode:"administrator",resource:"deployment",sensitive:true},
 "deployment.rollback":{mode:"administrator",resource:"deployment",sensitive:true},
 "support.account.read":{mode:"support",resource:"parent",sensitive:true},
 "service.analytics.contribute":{mode:"service",resource:"analytics"},
 "service.analytics.run":{mode:"service",resource:"analytics",sensitive:true},
 "service.authorization.decide":{mode:"service",resource:"authorization",sensitive:true},
 "service.entitlements.apply_cycle":{mode:"service",resource:"entitlement",sensitive:true},
 "service.entitlements.evaluate_access":{mode:"service",resource:"entitlement"},
 "service.entitlements.apply_lifecycle_event":{mode:"service",resource:"entitlement",sensitive:true},
 "service.entitlements.process_due_transitions":{mode:"service",resource:"entitlement",sensitive:true},
 "service.entitlements.reconcile_lifecycle":{mode:"service",resource:"entitlement",sensitive:true},
 "admin.entitlements.security_revoke":{mode:"administrator",resource:"entitlement",sensitive:true},
 "service.entitlements.reconcile_integrity":{mode:"service",resource:"entitlement",sensitive:true},
 "service.entitlements.reconcile_paid_cycle":{mode:"service",resource:"entitlement",sensitive:true},
 "service.entitlements.reconcile_learner_app":{mode:"service",resource:"entitlement",sensitive:true},
 "admin.entitlement_integrity.incident.read":{mode:"administrator",resource:"entitlement"},
 "admin.entitlement_integrity.incident.action":{mode:"administrator",resource:"entitlement",sensitive:true},
 "service.billing.provider_event":{mode:"service",resource:"subscription",sensitive:true},
 "service.billing.reconcile":{mode:"service",resource:"subscription",sensitive:true},
 "service.billing.renewal_reminder":{mode:"service",resource:"subscription",sensitive:true},
 "service.billing.grace_expiry":{mode:"service",resource:"subscription",sensitive:true},
 "service.billing.financial_event_webhook":{mode:"service",resource:"subscription",sensitive:true},
 "app.launch.exchange":{mode:"app_service",resource:"session",sensitive:true},
 "app.grant.renew":{mode:"app_service",resource:"grant",sensitive:true},
 "app.grant.status":{mode:"app_service",resource:"grant"},
 "app.progress.completions.read":{mode:"app_service",resource:"learner"},
 "app.progress.current.read":{mode:"app_service",resource:"learner"},
 "app.progress.write":{mode:"app_service",resource:"learner"},
 "app.lesson.complete":{mode:"app_service",resource:"learner",sensitive:true},
 "app.session.complete":{mode:"app_service",resource:"session",sensitive:true},
 "app.session.disconnect":{mode:"app_service",resource:"session",sensitive:true},
 "app.session.resume":{mode:"app_service",resource:"session",sensitive:true},
 "app.session.usable_launch":{mode:"app_service",resource:"session",sensitive:true},
 "app.progress.integrity.validate":{mode:"app_service",resource:"learner",sensitive:true},
 "service.progress_integrity.reconcile":{mode:"service",resource:"learner",sensitive:true},
 "admin.progress_integrity.incident.read":{mode:"administrator",resource:"learner"},
 "admin.progress_integrity.incident.action":{mode:"administrator",resource:"learner",sensitive:true},
 "admin.progress_integrity.health.read":{mode:"administrator",resource:"analytics"},
 "app.progress.recover":{mode:"app_service",resource:"learner",sensitive:true},
 "service.progress_recovery.reconcile":{mode:"service",resource:"learner",sensitive:true},
 "admin.progress_recovery.incidents.read":{mode:"administrator",resource:"learner"},
} as const;
export type AuthorizationAction=keyof typeof AUTHORIZATION_ACTIONS;
export class AuthorizationModeError extends Error{constructor(public readonly code:string){super(code);this.name="AuthorizationModeError";}}
export type EndUserAuthorizationContext={parentUserId:string;parentSessionId:string;deviceSessionId:string;mode:AuthorizationMode;
 learnerId?:string;credentialId?:string;contextVersion?:number};

export function registerAuthorizationActions(){const db=getDb();const insert=db.prepare(`insert into authorization_actions
 (action_key,required_mode,resource_type,sensitive,version,active) values(?,?,?,?,1,1)
 on conflict(action_key) do update set required_mode=excluded.required_mode,resource_type=excluded.resource_type,
 sensitive=excluded.sensitive,version=case when authorization_actions.required_mode<>excluded.required_mode
  or authorization_actions.resource_type<>excluded.resource_type or authorization_actions.sensitive<>excluded.sensitive
  then authorization_actions.version+1 else authorization_actions.version end,active=1`);
 for(const [key,value] of Object.entries(AUTHORIZATION_ACTIONS))
 insert.run(key,value.mode,value.resource,"sensitive" in value&&value.sensitive?1:0);}

function activeParent(parentUserId:string){const row=getDb().prepare("select account_status from profiles where id=?").get(parentUserId) as
 {account_status:string}|undefined;if(row?.account_status!=="active")throw new AuthorizationModeError("ACCOUNT_INACTIVE");}

export function deriveAuthorizationContext(input:{parentUserId:string;parentSessionId?:string;deviceSessionId?:string;now:Date}){
 activeParent(input.parentUserId);if(!input.parentSessionId||!input.deviceSessionId)throw new AuthorizationModeError("AUTHORIZATION_CONTEXT_UNAVAILABLE");
 const row=getDb().prepare("select * from learner_unlock_contexts where parent_session_id=? and device_session_id=?")
  .get(input.parentSessionId,input.deviceSessionId) as Record<string,unknown>|undefined;
 if(!row)return {parentUserId:input.parentUserId,parentSessionId:input.parentSessionId,deviceSessionId:input.deviceSessionId,
  mode:"parent_management" as const};
 if(row.parent_user_id!==input.parentUserId||row.status!=="active"||input.now>=new Date(String(row.expires_at)))
  throw new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID");
 const owned=getDb().prepare("select 1 from learners where id=? and owner_parent_id=?").get(row.learner_id,input.parentUserId);
 if(!owned)throw new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID");
 return {parentUserId:input.parentUserId,parentSessionId:input.parentSessionId,deviceSessionId:input.deviceSessionId,
  mode:"learner_mode" as const,learnerId:String(row.learner_id),credentialId:String(row.credential_id),contextVersion:Number(row.version)};
}

function auditDenied(context:EndUserAuthorizationContext,action:AuthorizationAction,code:string,resourceId?:string){
 const definition=AUTHORIZATION_ACTIONS[action];
 getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'authorization_boundary_denied',?)")
  .run(randomUUID(),context.parentUserId,JSON.stringify({action,mode:context.mode,code,resourceType:definition.resource,
   resourceReference:resourceId?"supplied":"none"}));}

export function authorizeEndUserAction(context:EndUserAuthorizationContext,action:AuthorizationAction,resource?:{learnerId?:string;parentUserId?:string}){
 const definition=AUTHORIZATION_ACTIONS[action];if(!definition)throw new AuthorizationModeError("AUTHORIZATION_ACTION_UNKNOWN");
 if(definition.mode==="app_service"){auditDenied(context,action,"FORBIDDEN");throw new AuthorizationModeError("FORBIDDEN");}
 if(context.mode!==definition.mode){const code=definition.mode==="learner_mode"?"LEARNER_PROFILE_LOCKED":"PARENT_REAUTHENTICATION_REQUIRED";
  auditDenied(context,action,code);throw new AuthorizationModeError(code);}
 if(resource?.parentUserId&&resource.parentUserId!==context.parentUserId){auditDenied(context,action,"RESOURCE_NOT_FOUND",resource.parentUserId);
  throw new AuthorizationModeError("RESOURCE_NOT_FOUND");}
 if(resource?.learnerId){const allowed=context.mode==="learner_mode"?resource.learnerId===context.learnerId:
   !!getDb().prepare("select 1 from learners where id=? and owner_parent_id=?").get(resource.learnerId,context.parentUserId);
  if(!allowed){auditDenied(context,action,"RESOURCE_NOT_FOUND",resource.learnerId);throw new AuthorizationModeError("RESOURCE_NOT_FOUND");}}
 return {allowed:true as const,action,mode:context.mode,learnerId:context.learnerId};
}

export function buildAuthorizedLearnerQueryScope(context:EndUserAuthorizationContext,action:AuthorizationAction){
 authorizeEndUserAction(context,action);return context.mode==="learner_mode"?{where:"id = ?",params:[context.learnerId!]}:
  {where:"owner_parent_id = ?",params:[context.parentUserId]};}

export function activateLearnerMode(input:{parentUserId:string;parentSessionId:string;deviceSessionId:string;
 learnerId:string;verificationReceiptId:string;expiresAt:Date;now:Date}){
 if(input.expiresAt<=input.now)throw new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID");
 activeParent(input.parentUserId);const db=getDb(),timestamp=input.now.toISOString();
 db.transaction(()=>{const receipt=db.prepare(`select credential_id from learner_mode_unlock_receipts where id=?
  and parent_user_id=? and parent_session_id=? and device_session_id=? and learner_id=? and consumed_at is null and expires_at>?`)
  .get(input.verificationReceiptId,input.parentUserId,input.parentSessionId,input.deviceSessionId,input.learnerId,timestamp) as
  {credential_id:string}|undefined;
 if(!receipt)throw new AuthorizationModeError("LEARNER_PROFILE_LOCKED");
 const selected=db.prepare(`select 1 from learner_selection_contexts where parent_session_id=? and parent_user_id=?
  and selected_learner_id=? and expires_at>?`).get(input.parentSessionId,input.parentUserId,input.learnerId,timestamp);
 if(!selected)throw new AuthorizationModeError("RESOURCE_NOT_FOUND");
 const owned=db.prepare("select 1 from learners where id=? and owner_parent_id=?").get(input.learnerId,input.parentUserId);
 if(!owned)throw new AuthorizationModeError("RESOURCE_NOT_FOUND");
 const consumed=db.prepare("update learner_mode_unlock_receipts set consumed_at=? where id=? and consumed_at is null")
  .run(timestamp,input.verificationReceiptId).changes;
 if(consumed!==1)throw new AuthorizationModeError("LEARNER_PROFILE_LOCKED");
 db.prepare(`insert into learner_unlock_contexts(parent_session_id,device_session_id,parent_user_id,learner_id,
  credential_id,status,expires_at,version,created_at,updated_at) values(?,?,?,?,?,'active',?,1,?,?)
  on conflict(parent_session_id,device_session_id) do update set learner_id=excluded.learner_id,credential_id=excluded.credential_id,
  status='active',expires_at=excluded.expires_at,version=learner_unlock_contexts.version+1,updated_at=excluded.updated_at,
  revoked_at=null,revocation_reason=null`).run(input.parentSessionId,input.deviceSessionId,input.parentUserId,input.learnerId,
  receipt.credential_id,input.expiresAt.toISOString(),timestamp,timestamp);
 db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_mode_activated',?)")
  .run(randomUUID(),input.parentUserId,JSON.stringify({learnerId:input.learnerId,deviceSessionId:input.deviceSessionId,
   credentialId:receipt.credential_id}));})();return deriveAuthorizationContext(input);
}

export function revokeLearnerMode(input:{parentUserId:string;parentSessionId:string;deviceSessionId:string;
 parentPasswordReauthenticated:boolean;now:Date}){if(!input.parentPasswordReauthenticated)throw new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED");
 const db=getDb(),timestamp=input.now.toISOString();const changed=db.prepare(`update learner_unlock_contexts set status='revoked',
 revoked_at=?,revocation_reason='parent_exit',version=version+1,updated_at=? where parent_session_id=? and device_session_id=?
 and parent_user_id=? and status='active'`).run(timestamp,timestamp,input.parentSessionId,input.deviceSessionId,input.parentUserId).changes;
 if(changed)db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_mode_revoked',?)")
  .run(randomUUID(),input.parentUserId,JSON.stringify({deviceSessionId:input.deviceSessionId,reason:"parent_exit"}));return changed===1;}
export function revokeLearnerContextsByCredential(credentialId:string,now:Date){const timestamp=now.toISOString();return getDb().prepare(
 `update learner_unlock_contexts set status='revoked',revoked_at=?,revocation_reason='credential_revoked',version=version+1,
 updated_at=? where credential_id=? and status='active'`).run(timestamp,timestamp,credentialId).changes;}
export function revokeLearnerContextsForSession(parentSessionId:string,now:Date){const timestamp=now.toISOString();return getDb().prepare(
 `update learner_unlock_contexts set status='revoked',revoked_at=?,revocation_reason='parent_logout',version=version+1,
 updated_at=? where parent_session_id=? and status='active'`).run(timestamp,timestamp,parentSessionId).changes;}
export function revokeLearnerContextsForParent(parentUserId:string,now:Date){const timestamp=now.toISOString();return getDb().prepare(
 `update learner_unlock_contexts set status='revoked',revoked_at=?,revocation_reason='parent_session_revoked',version=version+1,
 updated_at=? where parent_user_id=? and status='active'`).run(timestamp,timestamp,parentUserId).changes;}
