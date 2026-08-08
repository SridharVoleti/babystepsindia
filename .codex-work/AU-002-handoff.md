# AU-002 development handoff

Last updated: 2026-08-08 (Asia/Kolkata)

## Implementation status

The AU-002 authorization boundary is implemented and its automated acceptance,
non-functional, architecture, type, and full regression suites pass.

## Open functional dependency

AU-002 AC4 requires an exact selected-learner passkey verification before learner
mode can be activated. The AU-002 implementation now accepts only a short-lived,
single-use, server-recorded verification receipt and rejects replay, device/session
mismatch, learner mismatch, expired receipts, and already-expired learner contexts.

Production issuance of that receipt remains owned by **IA-004 — Windows Hello and
Apple passkey access for learners**, which is currently marked **Backlog** in the
requirements workbook. Until IA-004 supplies standards-conformant WebAuthn
registration and assertion verification, AU-002 is conditionally complete but its
passkey-gated learner-mode entry is not production-operable end to end.

Do not replace this dependency with a browser-supplied `passkeyVerified` flag or
an unverified credential identifier. IA-004 must call the trusted receipt seam
only after validating challenge, origin, RP ID, user verification, signature
counter, credential status, learner binding, parent session, and device context.

## Traceability note

The workbook currently has no AU-002 rows in `06_Acceptance_Tests` and a blank
`Test IDs` field for AU-002. Add `AT-AU-002-01` through `AT-AU-002-35` when the
supported spreadsheet artifact runtime is available.
