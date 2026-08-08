create table if not exists learner_mode_unlock_receipts (
  id uuid primary key,
  parent_user_id uuid not null references profiles(id) on delete cascade,
  parent_session_id uuid not null,
  device_session_id uuid not null,
  learner_id uuid not null references learners(id),
  credential_id uuid not null,
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > verified_at),
  check (expires_at <= verified_at + interval '60 seconds')
);
create index if not exists idx_learner_mode_unlock_receipt_expiry
  on learner_mode_unlock_receipts(expires_at,consumed_at);
alter table learner_mode_unlock_receipts enable row level security;
alter table learner_mode_unlock_receipts force row level security;
