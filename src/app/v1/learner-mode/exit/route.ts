import {NextResponse} from "next/server";
import {checkRateLimit} from "@/lib/auth/rate-limit";
import {sqliteAuthAdapter} from "@/lib/auth/sqlite-auth-adapter";
import {requireEndUserAuthorization} from "@/lib/authorization/api-guard";
import {AuthorizationModeError,deriveAuthorizationContext,revokeLearnerMode} from "@/lib/authorization/modes";
import {withLockedEndUserMutation} from "@/lib/authorization/locked-mutation";

export async function POST(request:Request){const guard=await requireEndUserAuthorization(request,"learner.mode.exit");if(!guard.ok)return guard.response;
 if(!checkRateLimit(`learner-mode-exit:${guard.parent.session.sub}`,10,60_000))return NextResponse.json({error:"RATE_LIMITED"},{status:429});
 try{const body=await request.json() as Record<string,unknown>;if(!body||Object.keys(body).some(k=>k!=="currentPassword")||
  typeof body.currentPassword!=="string")return NextResponse.json({error:"INVALID_REQUEST"},{status:400});
  const verified=await sqliteAuthAdapter.signInWithPassword(guard.parent.user.email,body.currentPassword);
  if(!verified)throw new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED");
  await withLockedEndUserMutation({preflight:guard.authorization,action:"learner.mode.exit",
   resource:{learnerId:guard.authorization.learnerId},mutate:()=>revokeLearnerMode({parentUserId:guard.parent.session.sub,
   parentSessionId:guard.parent.session.sid!,deviceSessionId:guard.authorization.deviceSessionId,
   parentPasswordReauthenticated:true,now:new Date()})});
  // PD-004 AC1/AC21: re-derive so the response carries the just-incremented
  // modeGeneration (the client broadcasts it to other tabs) rather than the
  // stale pre-exit value still sitting on `guard.authorization`.
  const context=await deriveAuthorizationContext({parentUserId:guard.parent.session.sub,parentSessionId:guard.parent.session.sid,
   deviceSessionId:guard.authorization.deviceSessionId,now:new Date()});
  return NextResponse.json({mode:"parent_management",modeGeneration:context.modeGeneration},{headers:{"Cache-Control":"no-store"}});
 }catch(error){const code=error instanceof AuthorizationModeError?error.code:"AUTHORIZATION_FAILED";
  return NextResponse.json({error:code},{status:403,headers:{"Cache-Control":"no-store"}});}}
