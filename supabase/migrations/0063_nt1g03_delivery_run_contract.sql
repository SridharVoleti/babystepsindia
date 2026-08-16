-- NT1-G03: API-NT-002's frozen runIdempotencyKey — one row per attempted
-- delivery-run call. 'running' guards against a concurrent/overlapping
-- replay (409); 'completed' makes a replay of the same key return the exact
-- same aggregate result without reprocessing any notification.
create table if not exists notification_delivery_runs (
  run_idempotency_key text primary key,
  state text not null default 'running' check(state in ('running','completed')),
  result_json text,
  created_at text not null,
  updated_at text not null
);
alter table notification_delivery_runs enable row level security;
alter table notification_delivery_runs force row level security;
