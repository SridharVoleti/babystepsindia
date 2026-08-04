-- LP-002: optimistic, parent+learner-scoped correction idempotency.
create table learner_profile_update_requests (
  parent_user_id uuid not null references profiles(id),
  learner_id uuid not null references learners(id),
  idempotency_key uuid not null,
  request_hash text not null,
  expected_version integer not null check (expected_version > 0),
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (parent_user_id, learner_id, idempotency_key)
);

create index idx_learner_profile_update_requests_status
  on learner_profile_update_requests(status, created_at);

alter table learner_profile_update_requests enable row level security;

-- No browser policies: the server transaction is the sole writer/reader.

-- Down migration (apply manually to reverse):
-- drop table if exists learner_profile_update_requests;
