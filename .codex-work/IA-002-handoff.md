# IA-002 development handoff

Last updated: 2026-08-08 (Asia/Kolkata)

## Fixed with test-driven development

- Removed legacy parent `date_of_birth` and `class_level` columns from the
  local and Supabase baseline schemas; added a forward migration for existing
  databases.
- Rejected address, parent date-of-birth and legal-name fields at the profile
  API boundary.
- Preserved authenticated email authority when a request injects an `email`
  field.
- Added minimal transactional profile-change audits without phone values.
- Added an invoice-recipient contract that always delivers to authenticated
  email and uses display name only as the optional label.
- Restored saved phone state on resume and preserved locale/timezone during
  retry/update.
- Made already-granted consent retries true no-ops so the original acceptance
  timestamp is preserved.
- Added a visible Retry state, programmatically associated phone validation,
  and a 320px-safe stacked phone layout.
- Exposed every country supported by the maintained libphonenumber metadata.
- Removed the Supabase owner-update policy so browser clients cannot bypass
  server E.164 validation, consent, onboarding transition and audit logic.
- Added direct evidence and traceability for all approved acceptance IDs
  `AT-IA-002-01` through `AT-IA-002-14`, plus a local p95 profile-path check.

## Open functional and production dependencies

IA-002 cannot be called production-complete until the following dependent
capabilities are deployed and evidenced:

- **Learner-creation handoff:** successful onboarding currently navigates to
  `/account`. LP-001 has a repository implementation, but no learner-creation
  page or POST route exists, so IA-002 cannot yet continue directly to the next
  required learner-profile step.
- **Invoice delivery:** the authenticated-email/recipient-label contract is
  implemented and tested, but no invoice or receipt generation/delivery
  pipeline exists in this workspace to demonstrate end-to-end delivery.
- **Supabase transaction:** the executable profile/consent/status/audit
  transaction currently runs in the local SQLite adapter. Production needs a
  server-only Supabase RPC (or equivalent database transaction) and deployment
  evidence that all four writes commit or roll back together under RLS.
- **Shared throttling and deployed performance:** the profile route uses the
  process-local development limiter. Production needs a shared multi-instance
  limiter and deployed p95 evidence below 1.5 seconds.

Until the learner-creation dependency is available, `/account` remains the
safe navigation target; pointing at a nonexistent route would create a broken
onboarding flow.
