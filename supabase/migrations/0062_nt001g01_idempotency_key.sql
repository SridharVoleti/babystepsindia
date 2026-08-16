-- NT1-G01: API-NT-001 frozen wire contract requires an explicit
-- idempotencyKey. Nullable/non-unique-by-default so existing in-process
-- callers (BI-002/003/004/005, IA-003) keep relying on the pre-existing
-- natural-key unique constraint as their identity; the partial unique index
-- enforces exact-once only for requests that actually supply one (the
-- API-NT-001 route).
alter table transactional_notification_intents add column if not exists idempotency_key text;

create unique index if not exists idx_transactional_notification_intents_idempotency_key
  on transactional_notification_intents(idempotency_key) where idempotency_key is not null;
