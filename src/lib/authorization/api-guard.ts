import {NextResponse} from "next/server";
import {requireApiParent} from "@/lib/auth/api-guard";
import {AuthorizationModeError,authorizeEndUserAction,deriveAuthorizationContext,type AuthorizationAction} from "@/lib/authorization/modes";
import {principalFromEndUserContext} from "@/lib/authorization/principals";

export async function requireEndUserAuthorization(_request:Request,action:AuthorizationAction,
 resource?:{learnerId?:string;parentUserId?:string}){const parent=await requireApiParent();if(!parent.ok)return parent;
 try{
  // IA-002's production Supabase session has already been verified by
  // requireApiParent. Parent-profile actions cannot enter learner mode and
  // have no learner resource, so avoid the legacy SQLite mode lookup.
  const productionProfileContext = process.env.NEXT_PUBLIC_SUPABASE_URL && action.startsWith("parent.profile.")
   ? {parentUserId:parent.context.session.sub,parentSessionId:parent.context.session.sid ?? `supabase:${parent.context.session.sub}`,
      deviceSessionId:parent.context.session.did ?? `supabase:${parent.context.session.sub}`,
      mode:"parent_management" as const,modeGeneration:0}
   : null;
  const authorizedContext=productionProfileContext ?? deriveAuthorizationContext({
   parentUserId:parent.context.session.sub,parentSessionId:parent.context.session.sid,
   deviceSessionId:parent.context.session.did,now:new Date()});
  authorizeEndUserAction(authorizedContext,action,resource);return {ok:true as const,parent:parent.context,authorization:authorizedContext,
   principal:principalFromEndUserContext(authorizedContext)};
 }catch(error){const code=error instanceof AuthorizationModeError?error.code:"AUTHORIZATION_CONTEXT_UNAVAILABLE";
  const status=code==="RESOURCE_NOT_FOUND"?404:code==="AUTHORIZATION_CONTEXT_UNAVAILABLE"?503:403;
  return {ok:false as const,response:NextResponse.json({error:code},{status,headers:{"Cache-Control":"no-store"}})};}}
