-- One-off: register the deployment-pipeline-scheduler platform service
-- principal in PRODUCTION. This principal authenticates the AR-002 sweep
-- endpoints (/v1/internal/deployments/{window-sweep,safety-sweep,retention-purge}).
-- window-sweep is what actually EXECUTES a scheduled production-promotion
-- window (business rules 55, 58) — without this principal, scheduled
-- production deployments never fire.
--
-- Generated 2026-08-29 by scripts/run-ar002-deployment-sweeps.mjs --generate-keypair.
-- Private key held out-of-repo as DEPLOYMENT_SWEEP_PRIVATE_KEY.
-- Run once against SUPABASE_DB_URL. Safe to re-run (rotates the key in place).

insert into platform_service_principals
  (id, service_key, key_ref, public_key, status, valid_from, valid_until, version)
values (
  gen_random_uuid(),
  'deployment-pipeline-scheduler',
  'manual://babysteps/deployment-sweep/2026-08-29',
  '-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATvUgbq0vOUCefgxJuxbYGeR7AQmVKWCQ1Q9KIUwH55s=
-----END PUBLIC KEY-----',
  'active',
  now(),
  now() + interval '3650 days',
  1
)
on conflict (service_key) do update set
  public_key  = excluded.public_key,
  key_ref     = excluded.key_ref,
  status      = 'active',
  valid_from  = excluded.valid_from,
  valid_until = excluded.valid_until,
  version     = platform_service_principals.version + 1;

select id, service_key, key_ref, status, valid_from, valid_until, version
from platform_service_principals
where service_key = 'deployment-pipeline-scheduler';
