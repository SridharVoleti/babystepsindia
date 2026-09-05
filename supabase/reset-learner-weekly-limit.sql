-- Testing-only runbook: fully clears a learner's weekly session limit for one
-- app by deleting the underlying learner_sessions rows (and every row that
-- transitively references them via FK) and resetting both weekly counters
-- to 0. Safe to re-run any time you hit WEEKLY_SESSION_LIMIT_REACHED or a
-- "duplicate key value violates unique constraint idx_learner_sessions_normal_slot"
-- crash while testing a launch.
--
-- Edit the two values below, then run the whole file as ONE execution in the
-- SQL editor (open this file locally and copy from your editor rather than
-- from a chat window, to avoid paste corruption on long/repeated text).
--
-- Uses a REGULAR table (not TEMP) as scratch space, because this SQL editor
-- runs each statement on its own connection -- a TEMP table would vanish
-- before the next statement ran ("relation tgt does not exist"). A plain
-- table persists in the database until step 6 explicitly drops it, so it
-- survives across separate connections/executions. If you stop partway
-- through, just re-run from step 1 (it drops-and-recreates tgt) rather than
-- leaving it orphaned.
--
-- Currently scoped to learner 'Shreshta' / app matching '%chess%' / week
-- '2026-W36' only (drop the "AND ... week_key = ..." lines in steps 1 and 5
-- to wipe all history for that learner+app instead, across every week).

-- ============================================================
-- 1. Resolve the target session ids into a scratch table.
-- ============================================================
DROP TABLE IF EXISTS tgt;

CREATE TABLE tgt AS
SELECT ls.id
FROM learner_sessions ls
WHERE ls.learner_id = (SELECT id FROM learners WHERE display_name = 'Shreshta')
  AND ls.app_id = (SELECT id FROM app_registry WHERE display_name ILIKE '%chess%' OR app_key ILIKE '%chess%')
  AND ls.week_key = '2026-W36';

-- ============================================================
-- 2. Delete second-level dependents (tables that reference a
--    level-1 dependent below, not learner_sessions directly).
-- ============================================================
DELETE FROM app_session_grant_requests WHERE grant_id IN
  (SELECT id FROM app_session_grants WHERE learner_session_id IN (SELECT id FROM tgt));
DELETE FROM achievement_mutation_receipts WHERE achievement_id IN
  (SELECT id FROM learner_achievements WHERE source_session_id IN (SELECT id FROM tgt));
DELETE FROM achievement_journey_projection_outbox WHERE achievement_id IN
  (SELECT id FROM learner_achievements WHERE source_session_id IN (SELECT id FROM tgt));

-- ============================================================
-- 3. Delete every table with a direct FK to learner_sessions(id).
-- ============================================================
DELETE FROM session_exit_transition_receipts WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM learner_session_launch_state WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM app_session_grants WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM session_start_requests WHERE session_id IN (SELECT id FROM tgt);
DELETE FROM session_replacement_credits
  WHERE original_session_id IN (SELECT id FROM tgt) OR consumed_session_id IN (SELECT id FROM tgt);
DELETE FROM session_finalization_requests WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM usable_launch_requests WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM learner_session_credits WHERE source_learner_session_id IN (SELECT id FROM tgt);
DELETE FROM technical_credit_claim_requests WHERE source_learner_session_id IN (SELECT id FROM tgt);
DELETE FROM learner_achievements WHERE source_session_id IN (SELECT id FROM tgt);
DELETE FROM progress_mutation_requests WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM progress_recovery_receipts WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM progress_recovery_incidents WHERE learner_session_id IN (SELECT id FROM tgt);
DELETE FROM learner_app_consistency_weeks WHERE cadence_completed_by_session_id IN (SELECT id FROM tgt);
DELETE FROM consistency_mutation_receipts WHERE source_session_id IN (SELECT id FROM tgt);

-- ============================================================
-- 4. Delete the sessions themselves.
-- ============================================================
DELETE FROM learner_sessions WHERE id IN (SELECT id FROM tgt);

-- ============================================================
-- 5. Reset both weekly counters for this learner+app.
--    (Never do this UPDATE alone without the deletes above --
--    zeroing normal_sessions_started while real rows still hold
--    a weekly_slot_number causes a 23505 collision on the next Start.)
-- ============================================================
UPDATE learner_app_week_usage
SET normal_sessions_started = 0,
    standard_sessions_funded = 0,
    version = version + 1,
    updated_at = now()
WHERE learner_id = (SELECT id FROM learners WHERE display_name = 'Shreshta')
  AND app_id = (SELECT id FROM app_registry WHERE display_name ILIKE '%chess%' OR app_key ILIKE '%chess%')
  AND week_key = '2026-W36';

-- ============================================================
-- 6. Clean up.
-- ============================================================
DROP TABLE tgt;
