-- PC-001 — Privacy by Design & Data Minimization
-- Parent email remains authoritative only in the identity store (`users.email`).
-- Cancellation notification work items retain only the subscription reference;
-- the billing notification service resolves the current parent email at delivery time.

alter table billing_cancellation_notifications
  drop column if exists recipient_email;

-- This table remains service-only under the RLS posture established by BI-004.
-- No new browser policy is introduced by PC-001.
