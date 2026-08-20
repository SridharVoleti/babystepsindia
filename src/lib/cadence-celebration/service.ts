import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { CADENCE_CELEBRATION_CONTEXT_VERSION, declaresSupportedCadenceCelebration,
  parseDeploymentManifest } from "@/lib/deployment-manifest/schema";
import { ConsistencyError } from "@/lib/consistency/service";
import type { AppProgressContext } from "@/lib/app-progress/service";
import type { CadenceCelebrationContext, CadenceCelebrationEligibility } from "./contracts";

type SessionRow = {
  id: string; learner_id: string; app_id: string; status: string; ended_at: string | null;
  source: string; week_key: string; deployment_environment: string | null; release_id: string | null;
};

export async function readCadenceCompletionContext(appId: string, sessionId: string): Promise<CadenceCelebrationEligibility> {
  const db = resolveDbClient();
  const session = await db.get<SessionRow>(`select id,learner_id,app_id,status,ended_at,source,week_key,
    deployment_environment,release_id from learner_sessions where id=?`, [sessionId]);
  if (!session || session.app_id !== appId) throw new ConsistencyError("CONSISTENCY_RESOURCE_NOT_FOUND");
  if (session.status !== "completed" || !session.ended_at || session.source !== "standard_monthly" || !session.release_id) {
    return { eligible: false };
  }
  const release = await db.get<{ manifest_json: string }>(
    "select manifest_json from app_releases where id=? and app_id=?", [session.release_id, appId]);
  if (!release) return { eligible: false };
  let declared = false;
  try { declared = declaresSupportedCadenceCelebration(parseDeploymentManifest(JSON.parse(release.manifest_json))); }
  catch { return { eligible: false }; }
  if (!declared) return { eligible: false };
  const environment = session.deployment_environment ?? "production";
  const week = await db.get<{
    cadence_target: number; qualifying_standard_sessions: number; status: string;
    cadence_completed_by_session_id: string | null;
  }>(`select cadence_target,qualifying_standard_sessions,status,cadence_completed_by_session_id
    from learner_app_consistency_weeks where learner_id=? and app_id=? and environment=? and weekly_key=?`,
    [session.learner_id, appId, environment, session.week_key]);
  if (!week || week.status !== "cadence_complete" || week.cadence_target !== 2 ||
      week.qualifying_standard_sessions !== 2 || week.cadence_completed_by_session_id !== session.id) {
    return { eligible: false };
  }
  const state = await db.get<{ current_streak_weeks: number; longest_streak_weeks: number }>(
    `select current_streak_weeks,longest_streak_weeks from learner_app_consistency
    where learner_id=? and app_id=? and environment=?`, [session.learner_id, appId, environment]);
  const app = await db.get<{ app_key: string; display_name: string }>(
    "select app_key,display_name from app_registry where id=?", [appId]);
  if (!state || !app) return { eligible: false };
  return { eligible: true, weeklyKey: session.week_key, cadenceTarget: 2, completedSessions: 2,
    currentStreakWeeks: state.current_streak_weeks, longestStreakWeeks: state.longest_streak_weeks,
    appRef: { appId, appKey: app.app_key, displayName: app.display_name },
    celebrationContextVersion: CADENCE_CELEBRATION_CONTEXT_VERSION };
}

async function storedContext(db: DbClient, context: AppProgressContext, completionIdempotencyKey: string) {
  const receipt = await db.get<{ response_json: string }>(`select response_json from session_finalization_requests
    where learner_session_id=? and app_principal_id=? and idempotency_key=?`,
    [context.learnerSessionId, context.principalId, completionIdempotencyKey]);
  if (!receipt) return null;
  try {
    return (JSON.parse(receipt.response_json) as { cadenceCelebrationContext?: CadenceCelebrationContext })
      .cadenceCelebrationContext ?? null;
  } catch { return null; }
}

// EG-003: this runs only after the caller's finalization transaction has
// committed. Context lookup and receipt enrichment are deliberately
// best-effort: a celebration can never delay or roll back completion.
export async function composeCadenceCelebrationAfterCommit<T extends object>(context: AppProgressContext,
  completionIdempotencyKey: string, result: T): Promise<T & { cadenceCelebrationContext?: CadenceCelebrationContext }> {
  const db = resolveDbClient();
  try {
    const prior = await storedContext(db, context, completionIdempotencyKey);
    if (prior) return { ...result, cadenceCelebrationContext: prior };
    const cadenceCelebrationContext = await readCadenceCompletionContext(context.appId, context.learnerSessionId);
    if (!cadenceCelebrationContext.eligible) return result;
    const enhanced = { ...result, cadenceCelebrationContext };
    const changed = (await db.run(`update session_finalization_requests set response_json=?
      where learner_session_id=? and app_principal_id=? and idempotency_key=?`,
      [JSON.stringify(enhanced), context.learnerSessionId, context.principalId, completionIdempotencyKey])).changes;
    return changed === 1 ? enhanced : result;
  } catch { return result; }
}
