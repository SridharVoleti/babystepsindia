-- BI-003: accepted provider identity/payload evidence and paid financial
-- snapshots are immutable. Processing status may advance, and paid periods
-- may change lifecycle status to refunded/disputed, without rewriting facts.
create or replace function reject_provider_event_context_change()
returns trigger language plpgsql as $$ begin
  raise exception 'provider event context is immutable';
end $$;
drop trigger if exists payment_provider_events_context_immutable on payment_provider_events;
create trigger payment_provider_events_context_immutable
before update of provider,environment,account_id,provider_event_id,event_type,payload_hash,
  checkout_intent_id,subscription_id,provider_checkout_ref,provider_payment_ref,received_at
on payment_provider_events for each row execute function reject_provider_event_context_change();

create or replace function reject_financial_evidence_delete()
returns trigger language plpgsql as $$ begin
  raise exception 'financial evidence is append-only';
end $$;
drop trigger if exists payment_provider_events_no_delete on payment_provider_events;
create trigger payment_provider_events_no_delete before delete on payment_provider_events
for each row execute function reject_financial_evidence_delete();

create or replace function reject_billing_period_context_change()
returns trigger language plpgsql as $$ begin
  raise exception 'billing period financial context is immutable';
end $$;
drop trigger if exists billing_periods_financial_context_immutable on billing_periods;
create trigger billing_periods_financial_context_immutable
before update of subscription_id,period_start,period_end,provider_payment_ref,amount,currency,
  price_id,price_version,source_provider_event_id,created_at on billing_periods
for each row execute function reject_billing_period_context_change();
drop trigger if exists billing_periods_no_delete on billing_periods;
create trigger billing_periods_no_delete before delete on billing_periods
for each row execute function reject_financial_evidence_delete();
