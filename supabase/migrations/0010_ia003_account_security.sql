-- IA-003 — parent credential changes and soft account deletion.
-- Mirrors src/lib/db/schema.sql column for column.

alter table profiles
  add column deleted_at timestamptz;

alter table profiles
  add column deleted_by_user_id uuid;

-- Authoritative "sessions issued at or before this instant are invalid"
-- gate — checked against the session JWT's iat even after account_status
-- is later restored to 'active' by an admin, which is what forces a
-- fresh login post-restore (business rule 14) without needing a separate
-- session-revocation table.
alter table profiles
  add column auth_revoked_before timestamptz;

-- Mirrors Supabase's own email_change flow so the product can show
-- pending state/expiry/resend/cancel — Supabase doesn't expose that as
-- queryable state itself. Only one row may be 'pending' per parent; a new
-- request cancels the previous one first rather than being blocked by it.
create table email_change_requests (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  old_email text not null,
  new_email text not null,
  status text not null default 'pending'
    check (status in ('pending','verified','expired','cancelled')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  cancelled_at timestamptz,
  supabase_request_nonce text
);

create unique index idx_email_change_requests_one_pending
  on email_change_requests(parent_user_id)
  where status = 'pending';

alter table email_change_requests enable row level security;

create policy "email change requests are readable by owner"
  on email_change_requests for select
  using (auth.uid() = parent_user_id);

-- Append-only.
create table parent_email_history (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  email text not null,
  archived_at timestamptz not null default now(),
  reason text not null default 'email_changed'
);

alter table parent_email_history enable row level security;

create policy "parent email history is readable by owner"
  on parent_email_history for select
  using (auth.uid() = parent_user_id);

-- Lightweight, queryable audit trail (no message broker in this stack).
-- Never stores passwords or tokens (AC15) — metadata is a small JSON blob
-- of non-sensitive context.
create table account_events (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index idx_account_events_parent on account_events(parent_user_id);

alter table account_events enable row level security;

create policy "account events are readable by owner"
  on account_events for select
  using (auth.uid() = parent_user_id);

-- Down migration (apply manually to reverse):
--
-- drop table if exists account_events;
-- drop table if exists parent_email_history;
-- drop table if exists email_change_requests;
-- alter table profiles drop column auth_revoked_before;
-- alter table profiles drop column deleted_by_user_id;
-- alter table profiles drop column deleted_at;
