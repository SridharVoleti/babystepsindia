-- BI-001 production certification: catalog versions are append-only facts.
-- Operational retirement remains possible through status/effective_to.
create or replace function prevent_product_price_version_change()
returns trigger language plpgsql as $$
begin
  raise exception 'product price version is immutable';
end;
$$;

drop trigger if exists product_prices_version_immutable on product_prices;
create trigger product_prices_version_immutable
before update of product_id,currency,billing_interval,interval_count,unit_amount,
  pricing_rule_version,supports_non_renewing,version on product_prices
for each row execute function prevent_product_price_version_change();

create or replace function prevent_subscription_catalog_snapshot_change()
returns trigger language plpgsql as $$
begin
  raise exception 'subscription catalog snapshot is immutable';
end;
$$;

drop trigger if exists subscriptions_catalog_snapshot_immutable on subscriptions;
create trigger subscriptions_catalog_snapshot_immutable
before update of product_id,product_version,billing_price_id,billing_price_version on subscriptions
for each row execute function prevent_subscription_catalog_snapshot_change();

-- Product/app membership is historical catalog data. New versions append new
-- rows; old versions cannot be rewritten out from under subscriptions.
create or replace function reject_product_version_app_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'product version app mapping is immutable';
end;
$$;

drop trigger if exists product_version_apps_no_update_delete on product_version_apps;
create trigger product_version_apps_no_update_delete
before update or delete on product_version_apps
for each row execute function reject_product_version_app_mutation();
