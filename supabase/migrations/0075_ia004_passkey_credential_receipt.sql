-- BR-003: reviewed-breaking-change
-- WebAuthn credential IDs are base64url strings, not UUIDs. PostgreSQL's
-- UUID-to-text conversion is lossless and both tables are empty pre-cutover.
alter table learner_mode_unlock_receipts
  alter column credential_id type text using credential_id::text;

alter table learner_unlock_contexts
  alter column credential_id type text using credential_id::text;
