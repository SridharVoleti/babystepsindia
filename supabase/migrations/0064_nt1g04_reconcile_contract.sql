-- NT1-G04: API-NT-004's own frozen runIdempotencyKey, kept in a table
-- separate from notification_delivery_runs so a caller reusing the same key
-- string for a delivery-run and a reconcile call can never collide.
create table if not exists notification_reconcile_runs (
  run_idempotency_key text primary key,
  state text not null default 'running' check(state in ('running','completed')),
  result_json text,
  created_at text not null,
  updated_at text not null
);
alter table notification_reconcile_runs enable row level security;
alter table notification_reconcile_runs force row level security;
