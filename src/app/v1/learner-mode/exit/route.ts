import {NextResponse} from "next/server";
import {checkRateLimit} from "@/lib/auth/rate-limit";
import {sqliteAuthAdapter} from "@/lib/auth/sqlite-auth-adapter";
import {requireEndUserAuthorization} from "@/lib/authorization/api-guard";
import {AuthorizationModeError,revokeLearnerMode} from "@/lib/authorization/modes";
import {withLockedEndUserMutation} from "@/lib/authorization/locked-mutation";

export async function POST(request:Request){const guard=await requireEndUserAuthorization(request,"learner.mode.exit");if(!guard.ok)return guard.response;
 if(!checkRateLimit(`learner-mode-exit:${guard.parent.session.sub}`,10,60_000))return NextResponse.json({error:"RATE_LIMITED"},{status:429});
 try{const body=await request.json() as Record<string,unknown>;if(!body||Object.keys(body).some(k=>k!=="currentPassword")||
  typeof body.currentPassword!=="string")return NextResponse.json({error:"INVALID_REQUEST"},{status:400});
  const verified=await sqliteAuthAdapter.signInWithPassword(guard.parent.user.email,body.currentPassword);
  if(!verified)throw new AuthorizationModeError("PARENT_REAUTHENTICATION_REQUIRED");
  withLockedEndUserMutation({preflight:guard.authorization,action:"learner.mode.exit",
   resource:{learnerId:guard.authorization.learnerId},mutate:()=>revokeLearnerMode({parentUserId:guard.parent.session.sub,
   parentSessionId:guard.parent.session.sid!,deviceSessionId:guard.authorization.deviceSessionId,
   parentPasswordReauthenticated:true,now:new Date()})});
  return NextResponse.json({mode:"parent_management"},{headers:{"Cache-Control":"no-store"}});
 }catch(error){const code=error instanceof AuthorizationModeError?error.code:"AUTHORIZATION_FAILED";
  return NextResponse.json({error:code},{status:403,headers:{"Cache-Control":"no-store"}});}}
