import { getDb } from "@/lib/db/client";
import { CADENCE_CELEBRATION_CONTEXT_VERSION, declaresSupportedCadenceCelebration,
  parseDeploymentManifest } from "@/lib/deployment-manifest/schema";
import { ConsistencyError } from "@/lib/consistency/service";
import type { AppProgressContext } from "@/lib/app-progress/service";
import type { CadenceCelebrationContext, CadenceCelebrationEligibility } from "./contracts";

type SessionRow = {
  id: string; learner_id: string; app_id: string; status: string; ended_at: string | null;
  source: string; week_key: string; deployment_environment: string | null; release_id: string | null;
};

export function readCadenceCompletionContext(appId: string, sessionId: string): CadenceCelebrationEligibility {
  const db = getDb();
  const session = db.prepare(`select id,learner_id,app_id,status,ended_at,source,week_key,
    deployment_environment,release_id from learner_sessions where id=?`).get(sessionId) as SessionRow | undefined;
  if (!session || session.app_id !== appId) throw new ConsistencyError("CONSISTENCY_RESOURCE_NOT_FOUND");
  if (session.status !== "completed" || !session.ended_at || session.source !== "standard_monthly" || !session.release_id) {
    return { eligible: false };
  }
  const release = db.prepare("select manifest_json from app_releases where id=? and app_id=?")
    .get(session.release_id, appId) as { manifest_json: string } | undefined;
  if (!release) return { eligible: false };
  let declared = false;
  try { declared = declaresSupportedCadenceCelebration(parseDeploymentManifest(JSON.parse(release.manifest_json))); }
  catch { return { eligible: false }; }
  if (!declared) return { eligible: false };
  const environment = session.deployment_environment ?? "production";
  const week = db.prepare(`select cadence_target,qualifying_standard_sessions,status,cadence_completed_by_session_id
    from learner_app_consistency_weeks where learner_id=? and app_id=? and environment=? and weekly_key=?`)
    .get(session.learner_id, appId, environment, session.week_key) as {
      cadence_target: number; qualifying_standard_sessions: number; status: string;
      cadence_completed_by_session_id: string | null;
    } | undefined;
  if (!week || week.status !== "cadence_complete" || week.cadence_target !== 2 ||
      week.qualifying_standard_sessions !== 2 || week.cadence_completed_by_session_id !== session.id) {
    return { eligible: false };
  }
  const state = db.prepare(`select current_streak_weeks,longest_streak_weeks from learner_app_consistency
    where learner_id=? and app_id=? and environment=?`).get(session.learner_id, appId, environment) as
    { current_streak_weeks: number; longest_streak_weeks: number } | undefined;
  const app = db.prepare("select app_key,display_name from app_registry where id=?")
    .get(appId) as { app_key: string; display_name: string } | undefined;
  if (!state || !app) return { eligible: false };
  return { eligible: true, weeklyKey: session.week_key, cadenceTarget: 2, completedSessions: 2,
    currentStreakWeeks: state.current_streak_weeks, longestStreakWeeks: state.longest_streak_weeks,
    appRef: { appId, appKey: app.app_key, displayName: app.display_name },
    celebrationContextVersion: CADENCE_CELEBRATION_CONTEXT_VERSION };
}

function storedContext(context: AppProgressContext, completionIdempotencyKey: string) {
  const receipt = getDb().prepare(`select response_json from session_finalization_requests
    where learner_session_id=? and app_principal_id=? and idempotency_key=?`)
    .get(context.learnerSessionId, context.principalId, completionIdempotencyKey) as { response_json: string } | undefined;
  if (!receipt) return null;
  try {
    return (JSON.parse(receipt.response_json) as { cadenceCelebrationContext?: CadenceCelebrationContext })
      .cadenceCelebrationContext ?? null;
  } catch { return null; }
}

// EG-003: this runs only after the caller's finalization transaction has
// committed. Context lookup and receipt enrichment are deliberately
// best-effort: a celebration can never delay or roll back completion.
export function composeCadenceCelebrationAfterCommit<T extends object>(context: AppProgressContext,
  completionIdempotencyKey: string, result: T): T & { cadenceCelebrationContext?: CadenceCelebrationContext } {
  try {
    const prior = storedContext(context, completionIdempotencyKey);
    if (prior) return { ...result, cadenceCelebrationContext: prior };
    const cadenceCelebrationContext = readCadenceCompletionContext(context.appId, context.learnerSessionId);
    if (!cadenceCelebrationContext.eligible) return result;
    const enhanced = { ...result, cadenceCelebrationContext };
    const changed = getDb().prepare(`update session_finalization_requests set response_json=?
      where learner_session_id=? and app_principal_id=? and idempotency_key=?`)
      .run(JSON.stringify(enhanced), context.learnerSessionId, context.principalId, completionIdempotencyKey).changes;
    return changed === 1 ? enhanced : result;
  } catch { return result; }
}
