-- BI-002 production certification: cancellation is a terminal commercial
-- boundary. Delayed/reordered renewal events may be audited, but cannot
-- reactivate or extend a subscription after cancellation became effective.
drop trigger if exists subscriptions_catalog_snapshot_immutable on subscriptions;
create trigger subscriptions_catalog_snapshot_immutable
before update of product_id,product_version on subscriptions
for each row execute function prevent_subscription_catalog_snapshot_change();

create or replace function enforce_cancelled_subscription_terminal()
returns trigger language plpgsql as $$
begin
  if old.status='cancelled' and (
    new.status<>old.status or
    new.current_period_start<>old.current_period_start or
    new.current_period_end<>old.current_period_end or
    new.payment_state<>old.payment_state
  ) then
    raise exception 'cancelled subscription lifecycle is terminal';
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_cancelled_terminal on subscriptions;
create trigger subscriptions_cancelled_terminal
before update on subscriptions
for each row execute function enforce_cancelled_subscription_terminal();
