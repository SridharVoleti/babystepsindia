-- SC-003: five-minute atomic session reservation and usable-launch
-- establishment. A session starts 'starting'/reserved and only becomes
-- 'active'/consumed once the app backend confirms usable launch (browser
-- runtime initialized); an unconfirmed reservation expires after 300s.
alter table learner_sessions drop constraint if exists learner_sessions_status_check;
alter table learner_sessions add constraint learner_sessions_status_check
  check (status in ('starting','active','disconnected','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch'));

alter table learner_sessions add column if not exists funding_state text not null default 'reserved'
  check (funding_state in ('reserved','consumed','released','expired'));
alter table learner_sessions add column if not exists reserved_at timestamptz;
alter table learner_sessions add column if not exists reservation_expires_at timestamptz;
create index if not exists idx_learner_sessions_reservation_expiry
  on learner_sessions(reservation_expires_at) where status = 'starting';

create table if not exists usable_launch_requests (
  learner_session_id uuid not null references learner_sessions(id),
  app_principal_id uuid not null references app_service_principals(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(learner_session_id,app_principal_id,idempotency_key)
);
alter table usable_launch_requests enable row level security;
