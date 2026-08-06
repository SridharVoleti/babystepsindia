import type { AuthorizationAction } from "@/lib/authorization/modes";

export type PlatformApiContract = {
  contractKey: string;
  version: "1.0";
  path: `/v1/${string}`;
  method: "GET" | "POST";
  canonicalAction: AuthorizationAction;
  authentication: "la002_dual_proof";
  browserCredential: "app_local_cookie_only";
  requestSchema: string;
  responseSchema: string;
  idempotency: "required" | "not_applicable_read";
  errors: readonly string[];
  rateLimit: string;
  auditClassification: "ordinary_read" | "sensitive_mutation";
  compatibility: "expand_contract";
  releaseGate: "required_staging_contract_test";
  approvalStatus: "approved";
  failureMode: "fail_closed_no_database_fallback";
};

function contract(input: Omit<PlatformApiContract,
  "version" | "authentication" | "browserCredential" | "compatibility" | "releaseGate" |
  "approvalStatus" | "failureMode">): PlatformApiContract {
  return {
    ...input,
    version: "1.0",
    authentication: "la002_dual_proof",
    browserCredential: "app_local_cookie_only",
    compatibility: "expand_contract",
    releaseGate: "required_staging_contract_test",
    approvalStatus: "approved",
    failureMode: "fail_closed_no_database_fallback",
  };
}

const commonErrors = ["AUTHENTICATION_REQUIRED", "FORBIDDEN", "RESOURCE_NOT_FOUND", "APP_DEPLOYMENT_WINDOW_BLOCKED"] as const;
const read = { idempotency: "not_applicable_read", auditClassification: "ordinary_read" } as const;
const write = { idempotency: "required", auditClassification: "sensitive_mutation" } as const;

export const PLATFORM_API_CONTRACTS = {
  launchExchange: contract({ contractKey: "app-launch.exchange", method: "POST", path: "/v1/internal/app-launch/exchange",
    canonicalAction: "app.launch.exchange", requestSchema: "AppLaunchExchangeRequestV1", responseSchema: "AppLaunchExchangeResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_app_principal_and_ip" }),
  grantRenew: contract({ contractKey: "app-session-grant.renew", method: "POST", path: "/v1/internal/app-session-grants/{grantId}/renew",
    canonicalAction: "app.grant.renew", requestSchema: "GrantRenewRequestV1", responseSchema: "GrantRenewResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_grant_and_principal" }),
  grantStatus: contract({ contractKey: "app-session-grant.status", method: "GET", path: "/v1/internal/app-session-grants/{grantId}/status",
    canonicalAction: "app.grant.status", requestSchema: "GrantStatusRequestV1", responseSchema: "GrantStatusResponseV1",
    ...read, errors: commonErrors, rateLimit: "per_grant_and_principal" }),
  progressCurrent: contract({ contractKey: "learner-progress.current", method: "GET", path: "/v1/internal/learner-app-progress/current",
    canonicalAction: "app.progress.current.read", requestSchema: "ProgressCurrentRequestV1", responseSchema: "ProgressCurrentResponseV1",
    ...read, errors: commonErrors, rateLimit: "per_session_and_app" }),
  progressCompletions: contract({ contractKey: "learner-progress.completions", method: "GET", path: "/v1/internal/learner-app-progress/completions",
    canonicalAction: "app.progress.completions.read", requestSchema: "ProgressCompletionsRequestV1", responseSchema: "ProgressCompletionsResponseV1",
    ...read, errors: commonErrors, rateLimit: "per_session_and_app" }),
  lessonComplete: contract({ contractKey: "learner-progress.lesson-complete", method: "POST", path: "/v1/internal/learner-app-progress/lessons/{lessonKey}/complete",
    canonicalAction: "app.lesson.complete", requestSchema: "LessonCompleteRequestV1", responseSchema: "LessonCompleteResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_session_and_lesson" }),
  sessionComplete: contract({ contractKey: "learner-session.complete", method: "POST", path: "/v1/internal/learner-sessions/{sessionId}/complete",
    canonicalAction: "app.session.complete", requestSchema: "SessionCompleteRequestV1", responseSchema: "SessionCompleteResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_session" }),
  sessionDisconnect: contract({ contractKey: "learner-session.disconnect", method: "POST", path: "/v1/internal/learner-sessions/{sessionId}/disconnect",
    canonicalAction: "app.session.disconnect", requestSchema: "SessionDisconnectRequestV1", responseSchema: "SessionDisconnectResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_session" }),
  sessionResume: contract({ contractKey: "learner-session.resume", method: "POST", path: "/v1/internal/learner-sessions/{sessionId}/resume",
    canonicalAction: "app.session.resume", requestSchema: "SessionResumeRequestV1", responseSchema: "SessionResumeResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_session" }),
  usableLaunch: contract({ contractKey: "learner-session.usable-launch", method: "POST", path: "/v1/internal/learner-sessions/{sessionId}/usable-launch",
    canonicalAction: "app.session.usable_launch", requestSchema: "UsableLaunchRequestV1", responseSchema: "UsableLaunchResponseV1",
    ...write, errors: commonErrors, rateLimit: "per_session" }),
} as const satisfies Record<string, PlatformApiContract>;

export function requireApprovedPlatformApiContract(contractKey: string, majorVersion: number) {
  const match = Object.values(PLATFORM_API_CONTRACTS).find((candidate) => candidate.contractKey === contractKey
    && Number(candidate.version.split(".")[0]) === majorVersion && candidate.approvalStatus === "approved");
  if (!match) throw new Error("PLATFORM_API_VERSION_UNSUPPORTED");
  return match;
}
