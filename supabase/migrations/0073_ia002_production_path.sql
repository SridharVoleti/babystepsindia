-- IA-002 production path: owner isolation plus a shared fixed-window limiter.
drop policy if exists "profiles are readable by owner" on profiles;
create policy "profiles are readable by owner"
  on profiles for select using (auth.uid() = id);

drop policy if exists "consent records are readable by owner" on consent_records;
create policy "consent records are readable by owner"
  on consent_records for select using (auth.uid() = parent_user_id);

alter table profiles force row level security;
alter table consent_records force row level security;

create table if not exists distributed_rate_limits (
  limiter_key text primary key,
  request_count bigint not null,
  window_started_at bigint not null,
  window_ends_at bigint not null
);

alter table distributed_rate_limits enable row level security;
alter table distributed_rate_limits force row level security;
-- No browser policy: only the server database role may consume counters.
