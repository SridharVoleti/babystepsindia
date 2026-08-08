# IA-001 development handoff

Last updated: 2026-08-08 (Asia/Kolkata)

## Fixed with test-driven development

- Signup validation feedback preserves only the submitted email; passwords are
  always cleared.
- The profile-recovery endpoint repairs a missing row before applying the
  normal active-parent and AU-002 parent-mode boundary, preventing learner-mode
  profile disclosure.
- Duplicate signup, password-reset, and verification-resend responses no longer
  disclose whether an email is registered.
- Production action responses never include verification or password-reset
  tokens. Local/test dummy links for unknown accounts preserve response shape
  without granting authority.
- The auth adapter independently validates normalized email and password policy
  for signup and password reset, even when form actions are bypassed.
- Login, verification resend, and password reset normalize email consistently.
- Weak reset passwords are rejected before a reset token is consumed.
- A successful password reset invalidates every outstanding reset token for the
  account.
- Reset-token consumption, password update, and token invalidation are atomic
  and rollback together on database failure.
- Email verification and token consumption are atomic and rollback together on
  database failure.
- All approved IDs `AT-IA-001-01` through `AT-IA-001-09` now have executable
  behavioral traceability.

## Open production dependencies

IA-001 cannot be called production-complete until deployment replaces the local
SQLite authentication stand-in with Supabase Auth and verifies the configured
email/password provider. In particular:

- Password hashes must live only in Supabase Auth, not the Babysteps database.
- Verification and reset messages must be delivered by the configured email
  provider; browser-returned local links are development-only.
- Signup, login, resend, and reset throttling must use a shared multi-instance
  rate-limit store rather than the current process-local limiter.
- Production evidence must confirm HTTPS, secure cookies, callback URLs, email
  templates, expiry settings, and p95 response time under deployed load.

These are deployment/integration dependencies, not safe substitutes to emulate
with browser-supplied tokens or platform-owned password storage.
