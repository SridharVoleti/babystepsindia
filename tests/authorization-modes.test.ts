import {beforeEach,describe,expect,it} from "vitest";
import {sqliteAuthAdapter} from "@/lib/auth/sqlite-auth-adapter";
import {createLearner} from "@/lib/db/learner-repo";
import {getDb} from "@/lib/db/client";
import {useInMemoryDb} from "@/lib/db/test-utils";
import {selectLearner} from "@/lib/learning-session/gateway";
import {AUTHORIZATION_ACTIONS,AuthorizationModeError,activateLearnerMode,authorizeEndUserAction,
 buildAuthorizedLearnerQueryScope,deriveAuthorizationContext,registerAuthorizationActions,
 revokeLearnerContextsByCredential,revokeLearnerContextsForSession,revokeLearnerMode} from "@/lib/authorization/modes";
import {withLockedEndUserMutation} from "@/lib/authorization/locked-mutation";
import {changePassword} from "@/lib/db/account-security-repo";
import {recordTrustedPasskeyVerification} from "@/lib/authorization/passkey-verification";

const now=new Date("2026-08-05T10:00:00.000Z"),parentSessionId="parent-session-1",deviceId="device-1";
beforeEach(()=>useInMemoryDb());
async function fixture(){const {user}=await sqliteAuthAdapter.signUp("mode-parent@example.com","CorrectHorse1!");
 getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
 const first=(await createLearner(user.id,{displayName:"Asha",dateOfBirth:"2018-01-01",idempotencyKey:crypto.randomUUID()},"2026-08-05")).learner;
 const second=(await createLearner(user.id,{displayName:"Ravi",dateOfBirth:"2019-01-01",idempotencyKey:crypto.randomUUID()},"2026-08-05")).learner;
 selectLearner(parentSessionId,user.id,first.id,"2026-08-06T00:00:00.000Z");registerAuthorizationActions();return{user,first,second};}
function activate(input:{parentUserId:string;parentSessionId:string;deviceSessionId:string;learnerId:string;
 credentialId:string;verified?:boolean;expiresAt:Date;now:Date}){
 const verificationReceiptId=input.verified===false?"missing-receipt":recordTrustedPasskeyVerification({
  parentUserId:input.parentUserId,parentSessionId:input.parentSessionId,deviceSessionId:input.deviceSessionId,
  learnerId:input.learnerId,credentialId:input.credentialId,verifiedAt:input.now,
  expiresAt:new Date(input.now.getTime()+60_000)}).id;
 return activateLearnerMode({parentUserId:input.parentUserId,parentSessionId:input.parentSessionId,
  deviceSessionId:input.deviceSessionId,learnerId:input.learnerId,verificationReceiptId,
  expiresAt:input.expiresAt,now:input.now});}

describe("AU-002 parent and nested learner authorization modes",()=>{
 it("starts in parent-management mode and prevents learning without passkey unlock",async()=>{const {user,first}=await fixture();
  const context=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now});
  expect(context.mode).toBe("parent_management");
  expect(authorizeEndUserAction(context,"parent.learners.list")).toMatchObject({allowed:true});
  expect(()=>authorizeEndUserAction(context,"learner.home.read",{learnerId:first.id}))
   .toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));});
 it("activates only the server-selected owned learner after trusted passkey verification",async()=>{const {user,first,second}=await fixture();
  expect(()=>activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",verified:false,expiresAt:new Date("2026-08-05T11:00:00Z"),now}))
   .toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));
  const context=activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  expect(context).toMatchObject({mode:"learner_mode",learnerId:first.id});
  expect(authorizeEndUserAction(context,"learner.session.start",{learnerId:first.id})).toMatchObject({allowed:true});
  expect(()=>authorizeEndUserAction(context,"learner.home.read",{learnerId:second.id}))
   .toThrowError(new AuthorizationModeError("RESOURCE_NOT_FOUND"));
  expect(()=>authorizeEndUserAction(context,"parent.billing.read"))
   .toThrowError(new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED"));
  const denial=getDb().prepare(`select metadata from account_events where event_type='authorization_boundary_denied'
   and json_extract(metadata,'$.action')='parent.billing.read'`).get() as {metadata:string}|undefined;
  expect(JSON.parse(denial!.metadata)).toEqual({action:"parent.billing.read",mode:"learner_mode",
   code:"PARENT_REAUTHENTICATION_REQUIRED",resourceType:"parent",resourceReference:"none"});});
 it("isolates modes by device and scopes before list pagination",async()=>{const {user,first}=await fixture();
  const learner=activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  const other=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:"device-2",now});
  expect(other.mode).toBe("parent_management");
  expect(buildAuthorizedLearnerQueryScope(learner,"learner.home.read")).toEqual({where:"id = ?",params:[first.id]});
  expect(buildAuthorizedLearnerQueryScope(other,"parent.learners.list")).toEqual({where:"owner_parent_id = ?",params:[user.id]});});
 it("fails closed for expiry and credential revocation within the authoritative context",async()=>{const {user,first}=await fixture();
  activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T10:01:00Z"),now});
  expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now:new Date("2026-08-05T10:01:00Z")}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  getDb().prepare("update learner_unlock_contexts set status='active',expires_at='2026-08-06T00:00:00Z'").run();
  expect(revokeLearnerContextsByCredential("cred-1",now)).toBe(1);
  expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));});
 it("requires parent-password reauthentication to leave learner mode and registers permanent actions",async()=>{const {user,first}=await fixture();
  activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  expect(()=>revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:false,now}))
   .toThrowError(new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED"));
  expect(revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:true,now})).toBe(true);
  expect(getDb().prepare("select count(*) n from authorization_actions").get()).toMatchObject({n:Object.keys(AUTHORIZATION_ACTIONS).length});
  expect(getDb().prepare("select count(*) n from account_events where event_type like 'learner_mode_%'").get()).toMatchObject({n:2});});
 it("repeats authorization under the write lock and rolls back a denied mutation",async()=>{const {user,first}=await fixture();
  const preflight=activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  getDb().prepare("update learner_unlock_contexts set status='revoked' where parent_session_id=? and device_session_id=?")
   .run(parentSessionId,deviceId);
  await expect(withLockedEndUserMutation({preflight,action:"learner.session.start",resource:{learnerId:first.id},now,
   mutate:()=>getDb().prepare("update learners set display_name='Unauthorized' where id=?").run(first.id)}))
   .rejects.toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  expect(getDb().prepare("select display_name from learners where id=?").get(first.id)).not.toMatchObject({display_name:"Unauthorized"});});
 it("AT-AU-002-18 revokes only the signed-out parent session and preserves another login",async()=>{const {user,first}=await fixture();
  selectLearner("parent-session-2",user.id,first.id,"2026-08-06T00:00:00.000Z");
  activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  activate({parentUserId:user.id,parentSessionId:"parent-session-2",deviceSessionId:"device-2",learnerId:first.id,
   credentialId:"cred-2",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  expect(revokeLearnerContextsForSession(parentSessionId,now)).toBe(1);
  expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  expect(deriveAuthorizationContext({parentUserId:user.id,parentSessionId:"parent-session-2",deviceSessionId:"device-2",now}).mode)
   .toBe("learner_mode");});
 it("AT-AU-002-18 revokes every nested learner context after a password change",async()=>{const {user,first}=await fixture();
  selectLearner("parent-session-2",user.id,first.id,"2026-08-06T00:00:00.000Z");
  for(const [session,device,credential] of [[parentSessionId,deviceId,"cred-1"],["parent-session-2","device-2","cred-2"]])
   activate({parentUserId:user.id,parentSessionId:session,deviceSessionId:device,learnerId:first.id,
    credentialId:credential,expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  await changePassword(user.id,"DifferentHorse2!");
  expect(getDb().prepare("select count(*) n from learner_unlock_contexts where status='active'").get()).toMatchObject({n:0});});

 describe("PD4-G01 authoritative modeGeneration",()=>{
  it("reports modeGeneration 0 for a session/device that never unlocked a learner",async()=>{const {user}=await fixture();
   const context=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now});
   expect(context).toMatchObject({mode:"parent_management",modeGeneration:0});});
  it("binds modeGeneration to learner_unlock_contexts.version once learner_mode is entered",async()=>{const {user,first}=await fixture();
   const context=activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
    credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
   expect(context).toMatchObject({mode:"learner_mode",modeGeneration:1,contextVersion:1});});
  it("AT-PD-004-21/28 a voluntary reauthenticated exit returns a usable parent_management context with an incremented, distinguishable modeGeneration — not a forced re-login",async()=>{
   const {user,first}=await fixture();
   activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
    credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
   expect(revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:true,now})).toBe(true);
   const context=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now});
   expect(context).toMatchObject({mode:"parent_management",modeGeneration:2});
   expect(authorizeEndUserAction(context,"parent.learners.list")).toMatchObject({allowed:true});});
  it("still fails closed (forces re-login) for a foreign revocation reason, not just expiry",async()=>{const {user,first}=await fixture();
   activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
    credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
   expect(revokeLearnerContextsByCredential("cred-1",now)).toBe(1);
   expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now}))
    .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));});
  it("increments modeGeneration again on re-entering learner_mode after a prior exit",async()=>{const {user,first}=await fixture();
   activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
    credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
   revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:true,now});
   const reentered=activate({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
    credentialId:"cred-1",expiresAt:new Date("2026-08-05T11:00:00Z"),now});
   expect(reentered.modeGeneration).toBe(3);});
 });
});
