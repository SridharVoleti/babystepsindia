import {NextResponse} from "next/server";
import {requireApiParent} from "@/lib/auth/api-guard";
import {AuthorizationModeError,authorizeEndUserAction,deriveAuthorizationContext,type AuthorizationAction} from "@/lib/authorization/modes";
import {principalFromEndUserContext} from "@/lib/authorization/principals";

export async function requireEndUserAuthorization(_request:Request,action:AuthorizationAction,
 resource?:{learnerId?:string;parentUserId?:string}){const parent=await requireApiParent();if(!parent.ok)return parent;
 try{const context=await deriveAuthorizationContext({parentUserId:parent.context.session.sub,parentSessionId:parent.context.session.sid,
  deviceSessionId:parent.context.session.did,now:new Date()});
  await authorizeEndUserAction(context,action,resource);return {ok:true as const,parent:parent.context,authorization:context,
   principal:principalFromEndUserContext(context)};
 }catch(error){const code=error instanceof AuthorizationModeError?error.code:"AUTHORIZATION_CONTEXT_UNAVAILABLE";
  const status=code==="RESOURCE_NOT_FOUND"?404:code==="AUTHORIZATION_CONTEXT_UNAVAILABLE"?503:403;
  return {ok:false as const,response:NextResponse.json({error:code},{status,headers:{"Cache-Control":"no-store"}})};}}
