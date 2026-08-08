-- AU-004: managed Ed25519 machine identity. Both machine-principal tables
-- move from an HS256 shared secret (resolved out of an env-var JSON map at
-- verify time) to a per-principal Ed25519 public key stored directly on the
-- row. The private key never touches the platform — it is generated and
-- held by whichever service (app backend, internal scheduler/worker) the
-- principal represents, and handed to the platform only as a public key at
-- onboarding. key_ref remains a human-readable rotation label.
alter table app_service_principals add column if not exists public_key text not null default '';
alter table platform_service_principals add column if not exists public_key text not null default '';
