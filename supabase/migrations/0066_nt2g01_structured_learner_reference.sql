-- NT2-G01: a structured, approved learner reference for source events that
-- legitimately have one — immune to a later learner rename, unlike the
-- display-name-only safe_variables.learnerName legacy rows carry.
-- Deliberately unconstrained text, not an FK to learners(id) — same
-- "actor/reference columns stay unconstrained" precedent AD-001 established.
alter table transactional_notification_intents add column if not exists learner_id text;
