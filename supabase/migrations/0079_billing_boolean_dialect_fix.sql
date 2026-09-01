-- Same class of bug as 0074_ia002_consent_records_dialect_fix.sql, same
-- fix: these three billing columns were declared `boolean`, but every
-- query against them (bi001/bi002-service.ts) uses the literal integer
-- 1/0 baked into SQL text or bound as a JS number, matching the SQLite/
-- schema.sql convention (SQLite has no real boolean type). Postgres
-- rejects an integer literal/parameter against a boolean column
-- ('column "x" is of type boolean but expression is of type integer'),
-- confirmed live provisioning ChessMasters' first product/subscription --
-- product_prices.supports_non_renewing failed on INSERT, then
-- subscriptions.cancel_at_period_end failed the same way on the very next
-- statement. Reads were also silently wrong: `row.auto_renew_enabled ===
-- 1` is false for a real Postgres boolean `true`, corrupting renewal-
-- eligibility and consent checks throughout bi001/bi002-service.ts.
--
-- No real data-loss risk: all three are recent (BI-001/BI-002, 2026-08)
-- and confirmed to hold only 0/1-equivalent values in practice.
-- BR-003: reviewed-breaking-change

begin;

-- product_prices_version_immutable (BEFORE UPDATE OF ...,supports_non_renewing,...)
-- depends on the column's presence, not its type, but Postgres still
-- refuses ALTER COLUMN TYPE while any trigger references it -- drop and
-- recreate verbatim around the type change.
drop trigger if exists product_prices_version_immutable on product_prices;

alter table product_prices alter column supports_non_renewing drop default;
alter table product_prices
  alter column supports_non_renewing type integer using (case when supports_non_renewing then 1 else 0 end);
alter table product_prices alter column supports_non_renewing set default 1;

create trigger product_prices_version_immutable
  before update of product_id, currency, billing_interval, interval_count, unit_amount,
    pricing_rule_version, supports_non_renewing, version on product_prices
  for each row execute function prevent_product_price_version_change();

-- Two partial indexes have predicates literally comparing these columns
-- to true/false -- same "can't ALTER COLUMN TYPE while something depends
-- on it" restriction as the trigger above.
drop index if exists idx_subscriptions_next_renewal;
drop index if exists idx_subscriptions_cancellation_effective;

alter table subscriptions alter column cancel_at_period_end drop default;
alter table subscriptions
  alter column cancel_at_period_end type integer using (case when cancel_at_period_end then 1 else 0 end);
alter table subscriptions alter column cancel_at_period_end set default 0;

alter table subscriptions alter column auto_renew_enabled drop default;
alter table subscriptions
  alter column auto_renew_enabled type integer using (case when auto_renew_enabled then 1 else 0 end);
alter table subscriptions alter column auto_renew_enabled set default 0;

create index idx_subscriptions_next_renewal on subscriptions(next_renewal_at, id)
  where auto_renew_enabled = 1 and cancel_at_period_end = 0;
create index idx_subscriptions_cancellation_effective on subscriptions(cancellation_effective_at, id)
  where cancel_at_period_end = 1;

commit;

-- Down migration (apply manually to reverse):
--
-- begin;
-- alter table product_prices alter column supports_non_renewing drop default;
-- alter table product_prices alter column supports_non_renewing type boolean using (supports_non_renewing <> 0);
-- alter table product_prices alter column supports_non_renewing set default true;
-- alter table subscriptions alter column cancel_at_period_end drop default;
-- alter table subscriptions alter column cancel_at_period_end type boolean using (cancel_at_period_end <> 0);
-- alter table subscriptions alter column cancel_at_period_end set default false;
-- alter table subscriptions alter column auto_renew_enabled drop default;
-- alter table subscriptions alter column auto_renew_enabled type boolean using (auto_renew_enabled <> 0);
-- alter table subscriptions alter column auto_renew_enabled set default false;
-- commit;
