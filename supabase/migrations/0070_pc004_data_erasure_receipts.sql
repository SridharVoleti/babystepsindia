-- PC-004: minimal, append-only deletion evidence for the existing
-- one-year post-entitlement learner retention timer
-- (learner_journey_retention_state, migration 00xx). No second retention
-- timer/state table.
create table if not exists data_erasure_receipts (
  id text primary key,
  learner_id text not null references learners(id),
  retention_generation integer not null,
  erased_at text not null,
  processor_status text not null default 'none_configured'
    check(processor_status in ('none_configured','pending','completed','failed')),
  processor_attempt_count integer not null default 0,
  replayed_at text,
  created_at text not null default (now()::text)
);
create index if not exists idx_data_erasure_receipts_learner
  on data_erasure_receipts(learner_id,created_at desc);
alter table data_erasure_receipts enable row level security;
alter table data_erasure_receipts force row level security;
