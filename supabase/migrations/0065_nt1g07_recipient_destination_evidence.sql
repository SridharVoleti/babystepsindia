-- NT1-G07: privacy-safe recipient/destination evidence for audit and
-- reconciliation. recipient_identity_version is the exact verified-at
-- timestamp that authorized the attempt; destination_hash is a one-way
-- SHA-256 of the normalized address — never the raw email itself, and never
-- a second authoritative parent email (that stays users.email).
alter table transactional_notification_deliveries add column if not exists recipient_identity_version text;
alter table transactional_notification_deliveries add column if not exists destination_hash text;
