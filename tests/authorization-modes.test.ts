import {beforeEach,describe,expect,it} from "vitest";
import {sqliteAuthAdapter} from "@/lib/auth/sqlite-auth-adapter";
import {createLearner} from "@/lib/db/learner-repo";
import {getDb} from "@/lib/db/client";
import {useInMemoryDb} from "@/lib/db/test-utils";
import {selectLearner} from "@/lib/learning-session/gateway";
import {AUTHORIZATION_ACTIONS,AuthorizationModeError,activateLearnerMode,authorizeEndUserAction,
 buildAuthorizedLearnerQueryScope,deriveAuthorizationContext,registerAuthorizationActions,
 revokeLearnerContextsByCredential,revokeLearnerMode} from "@/lib/authorization/modes";
import {withLockedEndUserMutation} from "@/lib/authorization/locked-mutation";

const now=new Date("2026-08-05T10:00:00.000Z"),parentSessionId="parent-session-1",deviceId="device-1";
beforeEach(()=>useInMemoryDb());
async function fixture(){const {user}=await sqliteAuthAdapter.signUp("mode-parent@example.com","CorrectHorse1!");
 getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
 const first=createLearner(user.id,{displayName:"Asha",dateOfBirth:"2018-01-01",idempotencyKey:crypto.randomUUID()},"2026-08-05").learner;
 const second=createLearner(user.id,{displayName:"Ravi",dateOfBirth:"2019-01-01",idempotencyKey:crypto.randomUUID()},"2026-08-05").learner;
 selectLearner(parentSessionId,user.id,first.id,"2026-08-06T00:00:00.000Z");registerAuthorizationActions();return{user,first,second};}

describe("AU-002 parent and nested learner authorization modes",()=>{
 it("starts in parent-management mode and prevents learning without passkey unlock",async()=>{const {user,first}=await fixture();
  const context=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now});
  expect(context.mode).toBe("parent_management");
  expect(authorizeEndUserAction(context,"parent.learners.list")).toMatchObject({allowed:true});
  expect(()=>authorizeEndUserAction(context,"learner.home.read",{learnerId:first.id}))
   .toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));});
 it("activates only the server-selected owned learner after trusted passkey verification",async()=>{const {user,first,second}=await fixture();
  expect(()=>activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:false,expiresAt:new Date("2026-08-05T11:00:00Z"),now}))
   .toThrowError(new AuthorizationModeError("LEARNER_PROFILE_LOCKED"));
  const context=activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:true,expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  expect(context).toMatchObject({mode:"learner_mode",learnerId:first.id});
  expect(authorizeEndUserAction(context,"learner.session.start",{learnerId:first.id})).toMatchObject({allowed:true});
  expect(()=>authorizeEndUserAction(context,"learner.home.read",{learnerId:second.id}))
   .toThrowError(new AuthorizationModeError("RESOURCE_NOT_FOUND"));
  expect(()=>authorizeEndUserAction(context,"parent.billing.read"))
   .toThrowError(new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED"));});
 it("isolates modes by device and scopes before list pagination",async()=>{const {user,first}=await fixture();
  const learner=activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:true,expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  const other=deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:"device-2",now});
  expect(other.mode).toBe("parent_management");
  expect(buildAuthorizedLearnerQueryScope(learner,"learner.home.read")).toEqual({where:"id = ?",params:[first.id]});
  expect(buildAuthorizedLearnerQueryScope(other,"parent.learners.list")).toEqual({where:"owner_parent_id = ?",params:[user.id]});});
 it("fails closed for expiry and credential revocation within the authoritative context",async()=>{const {user,first}=await fixture();
  activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:true,expiresAt:new Date("2026-08-05T10:01:00Z"),now});
  expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now:new Date("2026-08-05T10:01:00Z")}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  getDb().prepare("update learner_unlock_contexts set status='active',expires_at='2026-08-06T00:00:00Z'").run();
  expect(revokeLearnerContextsByCredential("cred-1",now)).toBe(1);
  expect(()=>deriveAuthorizationContext({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,now}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));});
 it("requires parent-password reauthentication to leave learner mode and registers permanent actions",async()=>{const {user,first}=await fixture();
  activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:true,expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  expect(()=>revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:false,now}))
   .toThrowError(new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED"));
  expect(revokeLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,parentPasswordReauthenticated:true,now})).toBe(true);
  expect(getDb().prepare("select count(*) n from authorization_actions").get()).toMatchObject({n:Object.keys(AUTHORIZATION_ACTIONS).length});
  expect(getDb().prepare("select count(*) n from account_events where event_type like 'learner_mode_%'").get()).toMatchObject({n:2});});
 it("repeats authorization under the write lock and rolls back a denied mutation",async()=>{const {user,first}=await fixture();
  const preflight=activateLearnerMode({parentUserId:user.id,parentSessionId,deviceSessionId:deviceId,learnerId:first.id,
   credentialId:"cred-1",passkeyVerified:true,expiresAt:new Date("2026-08-05T11:00:00Z"),now});
  getDb().prepare("update learner_unlock_contexts set status='revoked' where parent_session_id=? and device_session_id=?")
   .run(parentSessionId,deviceId);
  expect(()=>withLockedEndUserMutation({preflight,action:"learner.session.start",resource:{learnerId:first.id},now,
   mutate:()=>getDb().prepare("update learners set display_name='Unauthorized' where id=?").run(first.id)}))
   .toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  expect(getDb().prepare("select display_name from learners where id=?").get(first.id)).not.toMatchObject({display_name:"Unauthorized"});});
});
