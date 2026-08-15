-- NT-002: lightweight 13-month parent communication history, composed
-- directly from NT-001's own intents/deliveries tables (no new authoritative
-- table — rules 69-70). The only schema change this requirement needs is an
-- index to keep the parent-scoped, retention-windowed, newest-first keyset
-- read bounded (rule 72, NFR: "Parent+created_at index supports cursor
-- pagination").
create index idx_transactional_notification_intents_parent_history
  on transactional_notification_intents(parent_id, created_at desc, notification_id desc);
