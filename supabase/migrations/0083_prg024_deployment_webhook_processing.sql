-- PRG-024: processed provider webhooks update deployment state; every event is kept in an append-only history.
alter table deployment_webhook_receipts add column if not exists event_type text;
alter table deployment_webhook_receipts add column if not exists outcome text;
alter table deployment_webhook_receipts add column if not exists payload_sha256 text;

create table if not exists app_deployment_events (
  id text primary key,
  deployment_id text not null,
  receipt_id text not null,
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  from_status text not null,
  to_status text not null,
  applied integer not null check (applied in (0,1)),
  received_at timestamptz not null default now()
);
create index if not exists idx_app_deployment_events_deployment on app_deployment_events(deployment_id, received_at);

create or replace function reject_app_deployment_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'deployment events are immutable (append-only)';
end;
$$;
drop trigger if exists app_deployment_events_no_update_delete on app_deployment_events;
create trigger app_deployment_events_no_update_delete
before update or delete on app_deployment_events
for each row execute function reject_app_deployment_event_mutation();

alter table app_deployment_events enable row level security;
alter table app_deployment_events force row level security;
