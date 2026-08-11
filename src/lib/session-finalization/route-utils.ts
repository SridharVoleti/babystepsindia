import {NextResponse} from "next/server";
import {AppAuthorizationError} from "@/lib/app-authorization/service";
import {AppLaunchError} from "@/lib/app-launch/errors";
import {SessionFinalizationError} from "@/lib/session-finalization/service";
import {SessionCreditError} from "@/lib/session-credit/service";
import {LearnerSessionError} from "@/lib/learning-session/gateway";
import {SessionExitError} from "@/lib/session-exit/service";
export function lifecycleError(error:unknown){const code=error instanceof AppAuthorizationError||error instanceof AppLaunchError||
 error instanceof SessionFinalizationError||error instanceof SessionCreditError||error instanceof LearnerSessionError||error instanceof SessionExitError?
 error.code:"SESSION_LIFECYCLE_FAILED";
 const status=code==="IDEMPOTENCY_KEY_REUSED"||code.includes("VERSION_CONFLICT")||
  code==="FINAL_PROGRESS_NOT_ACKNOWLEDGED"||code==="SESSION_NOT_ACTIVE"?409:
  error instanceof AppAuthorizationError||error instanceof AppLaunchError?401:
  code.includes("NOT_ELIGIBLE")||code.includes("BINDING")||code.includes("NOT_FOUND")||code.includes("NOT_RESUMABLE")?404:
  code.includes("DEVICE_MISMATCH")||code.includes("CREDENTIAL_INVALID")||code.includes("HARD_EXPIRED")||code.includes("WINDOW_EXPIRED")?403:400;
 return NextResponse.json({error:code},{status,headers:{"Cache-Control":"no-store"}});}
