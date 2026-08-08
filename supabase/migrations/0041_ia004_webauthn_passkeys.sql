-- IA-004: real WebAuthn passkey credential registry and challenge lifecycle,
-- backing the learner_mode_unlock_receipts seam that AU-002 already
-- consumes (0036_au002_passkey_verification_receipts.sql).
create table if not exists learner_passkey_credentials (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  owner_parent_id uuid not null references profiles(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  sign_count bigint not null default 0,
  transports_json text not null default '[]',
  device_type text not null,
  backed_up boolean not null default false,
  label text not null,
  status text not null check(status in ('active','revoked')),
  created_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text
);
create index if not exists idx_learner_passkey_credentials_learner
  on learner_passkey_credentials(learner_id,status);
alter table learner_passkey_credentials enable row level security;
alter table learner_passkey_credentials force row level security;

create table if not exists webauthn_challenges (
  id uuid primary key,
  purpose text not null check(purpose in ('registration','authentication')),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  parent_session_id uuid not null,
  device_session_id uuid not null,
  learner_id uuid not null references learners(id),
  challenge_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists idx_webauthn_challenges_expiry
  on webauthn_challenges(expires_at,consumed_at);
alter table webauthn_challenges enable row level security;
alter table webauthn_challenges force row level security;
