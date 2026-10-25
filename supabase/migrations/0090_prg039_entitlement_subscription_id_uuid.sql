-- PRG-039/PRG-043: entitlement_cycles.subscription_id and learner_app_entitlement_periods.subscription_id were declared text while the table they
-- reference, subscriptions.id, is uuid. Every join between them (grace coverage, reverse reconciliation, consistency opening facts) failed on
-- PostgreSQL with 'operator does not exist: text = uuid'. The values are always genuine subscription ids written by the entitlement-cycle service.
-- BR-003: reviewed-breaking-change
begin;
alter table entitlement_cycles alter column subscription_id type uuid using subscription_id::uuid;
alter table learner_app_entitlement_periods alter column subscription_id type uuid using subscription_id::uuid;
commit;
