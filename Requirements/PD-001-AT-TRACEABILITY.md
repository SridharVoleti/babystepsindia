# PD-001 acceptance-test traceability (PD1-G01)

Explicit one-to-one map from every frozen `AT-PD-001-01..48` (source:
`Babysteps_Platform_Requirements_v56.xlsx`, `06_Acceptance_Tests` sheet —
the version PD-001 was actually built from; carried forward unchanged into
FINAL v65) to real test evidence. Built 2026-08-16 to close gap PD1-G01.

PD-001's composer (`src/lib/parent-dashboard/service.ts`) is a thin
read-only wrapper that reuses UL-001's `composeLearnerHome` for per-app card
data and PD-003's `composeParentAttention` for the attention preview — it
never re-derives that logic. Several AT cases are therefore genuinely
covered by the *reused composer's own* test suite, not duplicated inside
PD-001's own tests; those are marked "via reuse" below with the real file.

| AT | Status | Evidence |
|---|---|---|
| 01 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-01: returns one learner section per owned learner (Given: parent owns 3 learners)" |
| 02 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "never surfaces another parent's learner" |
| 03 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "shows a current app card with status/progress/consistency..." |
| 04 | Covered | `tests/pd-001-architecture.test.ts` — "AT-04: exactly one effective-entitlement row can exist per learner+app+environment" (EN-002's own `unique(learner_id,app_id,environment)` constraint on `learner_app_effective_entitlements`; composeLearnerHome reads one row per app, so an overlap can never produce two cards) |
| 05 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — "excludes an app whose entitlement period has ended" |
| 06 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-06: 0/2 is displayed as-is..." |
| 07 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-07: 1/2 is displayed as-is" |
| 08 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-08: 2/2 is displayed as-is" |
| 09 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-09: a catch-up-eligible third session is never promoted past the 2/2 cap..." |
| 10 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — "shows the PR-003 summary when present..." |
| 11 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-11: the app-owned motivation display type/labels pass through unchanged..." |
| 12 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-12: streak is per-app..." |
| 13 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-13: recent achievements pass through faithfully..." |
| 14 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — "keeps a card visible but temporarily_unavailable..." |
| 15 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "shows a current app card..." (asserts no `session`/`eligibility`/`primaryAction` on the returned card) |
| 16 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "is a pure read — writes nothing to the database" |
| 17 | Covered | same test as 16 (credit-balance table included in the pure-read assertion) |
| 18 | Covered | same test as 16 (weekly-usage table included in the pure-read assertion) |
| 19 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-19/20: 'Open learner' routes to the AU-002 unlock page..." (the link's only target is `/account/learners/{id}/unlock`; the real unlock-ceremony enforcement is AU-002/IA-004's own extensively tested boundary, not re-derived here) |
| 20 | Covered | same test as 19 (asserts no `/learner` or app-launch route is ever linked directly from the dashboard) |
| 21 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-21: a learner with zero current apps still gets a section..." |
| 22 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — progress-summary-missing case (renders `learning_not_started`, never hidden) |
| 23 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — "hides the summary with no invented fallback when PR-004 marks it unsafe" |
| 24 | Covered (via reuse) | `tests/ul-001-learner-home-composition.test.ts` — per-app throw isolation |
| 25 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "isolates one learner's composition failure and still returns the others" |
| 26 | Covered (via reuse) | `tests/pd-003-attention.test.ts` — grace/failed-payment attention item |
| 27 | Covered (via reuse) | `tests/pd-003-attention.test.ts` — reversible cancellation attention item |
| 28 | Covered (via reuse) | `tests/pd-003-attention.test.ts` — generic suspended_security attention item, no reason leak |
| 29 | Covered | `tests/pd-001-architecture.test.ts` — "AT-29: no sibling-learner ranking/comparison computation exists in the composer" |
| 30 | Covered | `tests/pd-001-architecture.test.ts` — "AT-30: no cross-app normalized/averaged score computation exists in the composer" |
| 31 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "orders learners in stable creation order, never by performance" |
| 32 | Covered | `tests/pd-001-architecture.test.ts` — "AT-32: the dashboard page is a plain server component with zero client-side polling capability" |
| 33 | **Not automatable — documented manual/Hybrid** | No offline caching / service-worker mechanism exists anywhere in this codebase to exercise (confirmed by source search). The frozen spec itself classifies this AT as "Hybrid". Manual verification only: open the dashboard, disconnect, confirm the last-rendered view stays visible read-only and no write action is reachable. Flag if a future session adds real offline support — this AT should get real automated coverage at that point. |
| 34 | Covered | `tests/pd-001-dashboard-route.test.ts` — "passes through guard denial" (the route never overrides `requireEndUserAuthorization`'s decision; the specific suspended-parent → 403 behavior is that guard's own tested responsibility, not re-derived here) |
| 35 | Covered | `tests/pd-001-dashboard-route.test.ts` — "derives the parent from the session, never a query parameter" |
| 36 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-36/37: renders a deliberate desktop app grid..." |
| 37 | Covered | same test as 36 (`grid-cols-1 sm:grid-cols-2`, no `<table>`) |
| 38 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-38: every interactive element is a real >=44px touch target" — **fixed a real gap while adding this test**: the "Review →" attention link had no `min-h-[44px]` class; added it in `src/app/account/page.tsx` |
| 39 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-39: status is conveyed as a text label, never color alone" |
| 40 | Covered, with a documented limitation | `tests/pd-001-dashboard-ui.test.tsx` — "AT-40: a parent with zero learners sees a clear, non-broken empty state". The spec's "Clear path" (an add-a-learner CTA) is not implemented: **no learner-creation route/UI exists anywhere in this codebase** (`createLearner` has zero callers under `src/app/`) — a pre-existing, cross-cutting gap flagged by multiple prior sessions since 2026-08-08, not PD-001-specific and out of this issue's scope to invent. |
| 41 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-41: no loading skeleton fabricates real-looking data" (source-scan; no `loading.tsx` exists — the page is a blocking server component, not a skeleton-then-hydrate pattern) |
| 42 | Covered | `tests/pd-001-dashboard-ui.test.tsx` — "AT-42: very long learner/app display names wrap safely..." — **fixed a real gap while adding this test**: neither the learner-name `<h2>` nor the app-name `<h4>` had a wrap-safety class; added `break-words` to both in `src/app/account/page.tsx` |
| 43 | Covered | `tests/pd-001-architecture.test.ts` — "AT-43: the dashboard never renders audio/video/autoplay content" |
| 44 | Covered | `tests/pd-001-parent-dashboard.test.ts` — "AT-44: composing 10 learners x 10 apps each stays within a bounded time..." (wall-clock bound; real 10x10 fixture, not mocked) |
| 45 | Covered | `tests/pd-001-dashboard-route.test.ts` — "returns 304 when the request ETag matches" |
| 46 | Covered | `tests/pd-001-architecture.test.ts` — "AT-46: the dashboard has no durable table of its own..." (`src/lib/parent-dashboard/service.ts` makes zero `getDb()` calls; no `parent_dashboard` table in `schema.sql`) |
| 47 | Covered | `tests/pd-001-architecture.test.ts` — "AT-47: the dashboard module has no write/mutation export and the route only ever exports GET" |
| 48 | Covered | `tests/pd-001-architecture.test.ts` — "the dashboard app-card type never carries a raw learning/payment/security field" (structural: `session`/`eligibility`/`primaryAction` are stripped; no credential-shaped field name appears anywhere in the composer) |

## Summary

- **47 of 48** AT cases have real, named, passing automated test evidence.
- **1** (AT-33, offline behavior) is explicitly documented as manual/Hybrid —
  no automatable mechanism exists in this codebase today, consistent with
  the frozen spec's own "Hybrid" classification for that case.
- **2 real UI gaps were found and fixed** while building this map (not just
  documented): a sub-44px "Review →" attention link, and two headings
  missing `break-words` wrap-safety for long names. Both fixed in
  `src/app/account/page.tsx`.
- **1 pre-existing, cross-cutting, out-of-scope limitation was found and
  documented, not fixed**: AT-40's "clear path to add a learner" cannot be
  implemented because no learner-creation UI/route exists anywhere in this
  codebase yet — a gap that predates PD-001 and spans multiple building
  blocks, not something to invent inside this dashboard fix.
- Required cross-domain regressions (AU-002 unlock boundary, PD-003
  attention composition, UL-001 card composition, EN-002 effective-access
  uniqueness, PR-003/PR-004 progress-summary safety) are all covered either
  directly or via the reused composer's own suite, listed above.

Test files: `tests/pd-001-parent-dashboard.test.ts`,
`tests/pd-001-dashboard-route.test.ts`, `tests/pd-001-architecture.test.ts`
(new), `tests/pd-001-dashboard-ui.test.tsx` (new).
