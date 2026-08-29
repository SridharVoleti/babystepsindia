-- One-off: register the ci-deployment-service platform service principal in PRODUCTION.
-- Generated 2026-08-28 by scripts/create-ci-deployer-release.mjs --generate-keypair.
-- The matching Ed25519 private key is held out-of-repo as CI_DEPLOYER_PRIVATE_KEY.
-- Run once against SUPABASE_DB_URL (Supabase SQL Editor, or: psql "$SUPABASE_DB_URL" -f this file).
-- Safe to re-run: `on conflict` rotates the key in place; existing app_releases are unaffected
-- (they store only the principal id, not the key).

insert into platform_service_principals
  (id, service_key, key_ref, public_key, status, valid_from, valid_until, version)
values (
  gen_random_uuid(),
  'ci-deployment-service',
  'manual://babysteps/ci-deployer/2026-08-28',
  '-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5unLk6bCQqxu8TLjWUHsDfHh97PhqdyqyoCuLimV6+w=
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

-- Verify:
select id, service_key, key_ref, status, valid_from, valid_until, version
from platform_service_principals
where service_key = 'ci-deployment-service';
