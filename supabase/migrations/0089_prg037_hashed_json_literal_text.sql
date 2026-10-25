-- PRG-037: schema_json and current_state_json are covered by integrity digests/hashes computed in the application over the LITERAL serialized text
-- (app_progress_schemas.schema_digest, learner_app_progress.state_hash). As jsonb, PostgreSQL rewrites that text (spacing, key order), so on read-back
-- the digest/hash could never match: every checkpoint failed with PROGRESS_SCHEMA_UNSUPPORTED and stored progress would classify as corrupt.
-- Store the literal text instead (the SQLite convention) and recompute the schema digests over the stored text. state_hash values for rows that
-- were already round-tripped through jsonb cannot be recomputed in SQL (they cover more than the text) and are left for PR-004 reconciliation.
-- BR-003: reviewed-breaking-change
begin;
alter table app_progress_schemas alter column schema_json type text using schema_json::text;
update app_progress_schemas set schema_digest = encode(sha256(convert_to(schema_json, 'UTF8')), 'hex');
alter table learner_app_progress alter column current_state_json type text using current_state_json::text;
commit;
