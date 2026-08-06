-- AN-001: scheduler and contribution services are separate managed identities.
-- Secrets are never stored here; key_ref resolves through the production
-- secret manager / PLATFORM_SERVICE_SECRETS and can be rotated independently.
insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000001', 'analytics-scheduler',
   'analytics-scheduler-v1', 'active', now(), 'infinity', 1),
  ('a1000000-0000-4000-8000-000000000002', 'analytics-contributor',
   'analytics-contributor-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;
