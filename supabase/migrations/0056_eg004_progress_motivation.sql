-- EG-004 extends the existing PR-003 summary row. Motivation is app-owned
-- presentation data, not a platform-derived progress model or separate table.
alter table learner_app_progress
  add column if not exists progress_summary_version integer not null default 0;
alter table learner_app_progress
  add column if not exists progress_summary_state_hash text;

alter table progress_mutation_requests drop constraint if exists progress_mutation_requests_operation_check;
alter table progress_mutation_requests add constraint progress_mutation_requests_operation_check
  check(operation in ('checkpoint','lesson_complete','summary_write'));

comment on column learner_app_progress.progress_summary_version is
  'EG-004 exact acknowledgement version for the nested PR-003 progress summary.';
comment on column learner_app_progress.progress_summary_state_hash is
  'EG-004 canonical hash of the exact app-owned summary representation and acknowledgement metadata.';
