# Onboarding & launching a partner app on BabySteps — end‑to‑end guide

**Written 2026-08-28 against live production (`www.babystepsindia.com`) + the code on
`codex/v49-billing-launcher`, using ChessMasters as the worked example.**

This is the whole chain from "an app exists in a git repo" to "a child taps *Open* in
BabySteps and the game loads with them signed in." Every step, who can do it, what it
needs, and where the current gaps are. The last section is a concrete plan to make
steps 3–8 a single script for the next app.

---

## The chain at a glance

| # | Step | Where | Who / credential | ChessMasters status |
|---|------|-------|------------------|---------------------|
| 1 | Register the app | `/admin/apps` → **Register app** | Staff (Platform Administrator) | ✅ done — `chess-masters`, v3 |
| 2 | Activate the app | app detail page → **Activate** | Staff + reauth | ✅ done — active since 8/27 |
| 3 | Bind a provider project (staging + production) | `/admin/apps/{id}/deployments` → **Bind project** | Staff; needs Vercel team + project id | ✅ done — `prj_Rwz5zZQbqpOHBYYQJ5JLDsBVGjQv` both envs, `verified` |
| 4 | App ships the launch routes | partner repo (`SridharVoleti/ChessMaster`) | App team | ✅ done — `/health` 200, `/launch` 405‑on‑GET, `/return` 303, `/identity` 501 (as of commit `ed47bae`) |
| 5 | CI cuts a release | `POST /v1/internal/apps/{id}/releases` | **`ci-deployer` service principal** (not a browser) | ⚠️ stale — all 4 releases point at old commit `07fd41f`; none for `ed47bae` |
| 6 | Staging deploy + verification | deployment pipeline (automatic once a release exists) | pipeline | ❌ `retry-5` = `staging_failed` (was failing on `/health` 404, now fixed — needs a fresh release to re‑run) |
| 7 | Promote a verified release to production | `/admin/apps/{id}/deployments` → **Schedule production deployment** | Staff + **current password** + **recent reauth** | ❌ nothing published (dev/staging/prod all "Not published") |
| 8 | Provision the app‑service principal + bootstrap secret | out‑of‑band ops | ops — inserts `app_service_principals` row, sets `APP_LAUNCH_BOOTSTRAP_SECRET` on the app | ❌ not done (no published deployment to bind it to yet) |
| 9 | A parent buys a subscription for the app and assigns it to a learner | `/account/subscriptions/new` | Parent | ❌ not done |
| 10 | Learner enters learner mode (passkey) and taps **Open** | `/learner` | Learner (WebAuthn ceremony) | ❌ blocked — see step 11 |
| 11 | **`POST /v1/learner-sessions` creates the session** → `startLearnerSession()` | *this repo* | — | ❌ **route does not exist** (LP‑004 gap, open since 2026‑08‑05) |
| 12 | `POST /v1/learner-sessions/{id}/launch-dispatch` → renders auto‑submit form to the app's `/launch` | this repo | Learner | ✅ route exists, waiting on step 11 |
| 13 | App calls `POST /v1/internal/app-launch/exchange` with its signed assertion → gets the bootstrap JWT | app backend | app (Ed25519 key from step 8) | ✅ route exists |
| 14 | App verifies the bootstrap JWT, starts its local session, confirms usable launch | app | app | ✅ SDK exists (`src/lib/app-launch/app-sdk.ts`) |

---

## Step‑by‑step

### 1–2. Register + activate (browser, staff)

`/admin/apps` → **Register app**. Key is permanent and lowercase‑kebab (`chess-masters`);
display name, short description, icon (must reference an `approved_app_icons` row —
these are seeded per environment, see [`babysteps-deploy-and-email` memory]), category,
owning team. Then open the app and **Activate** (sensitive action → password reauth).

Result: `app_registry` row, `registry_status='active'`. Nothing is launchable yet.

### 3. Bind a provider project (browser, staff)

`/admin/apps/{id}/deployments` → **Bind project** form: Environment, Provider team ID,
Provider project ID, Expected repository (`owner/repo`). Bind **staging** and
**production** separately (they can point at the same Vercel project). There is
deliberately **no field for a live URL** — BabySteps only ever trusts the origin the
provider confirms after its own verification.

### 4. App ships the launch routes (partner repo)

Root‑level routes (not under `/api`): `app/health/route.ts`, `app/launch/route.ts`,
`app/return/route.ts`, `app/identity/route.ts`. Contracts in
`CHESSMASTER_LAUNCH_INTEGRATION.md`. Minimum bar: `GET /health` returns **2xx directly**
(no redirect — the pipeline stopped following redirects after a Vercel SSO redirect was
misread as healthy). `/launch` is `POST`‑only. A framework‑agnostic reference handler
for steps 13–14 lives in this repo at `src/lib/app-launch/app-sdk.ts`
(`handleAppLaunchPost` + `establishAppLocalSession`).

### 5. CI cuts a release (`ci-deployer`, not a browser)

`POST /v1/internal/apps/{appId}/releases`, guarded by
`requireInternalService(request, "ci-deployer")` — a signed platform‑service assertion,
**no browser/admin equivalent** (`src/app/v1/internal/apps/[appId]/releases/route.ts`).
Body carries `sourceRepository`, `sourceCommitSha`, `dependencyLockHash`,
`buildInputHash`, `artifactDigest`, `manifest` (incl. `launchPath`), `gateResults`
(dependencyInstall/typeCheck/lint/unitTests/contractTests/security/build — all must be
true), `idempotencyKey`.

> **Gap:** nothing in this repo seeds the `platform_service_principals` row for the
> `ci-deployer` role — it's a manual ops step (README, "same operational gap as the
> pre-existing `scheduler`/`ci-deployer` roles"). The ChessMasters releases so far were
> created via a "manual‑attestation" run outside this repo.

### 6. Staging deploy + verification (pipeline)

Once a release exists the pipeline deploys it to the bound **staging** project and runs
verification, including `GET /health`. Pass → release status `verified`. Fail →
`staging_failed` (what ChessMasters' `retry-5` shows — it was hitting `/health` 404
before commit `ed47bae`). A fixed app needs a **new release** to re‑run this; there is
no "retry verification" button.

### 7. Promote to production (browser, staff, password‑gated)

`/admin/apps/{id}/deployments` → under a `verified` release, **Schedule production
deployment**: `Starts at` (≥ 60 min ahead), `Ends at`, **Current password**. Also
requires a **recent reauthentication** (the page shows `RECENT_REAUTHENTICATION_REQUIRED`
until you reauth). When the window opens the deployment publishes and
`app_environment_publications.current_published_deployment_id` is set — this pointer is
the *only* trusted source for "which deployment a new session gets"
(`getPublishedDeployment`, `src/lib/deployment-production/service.ts`).

### 8. Provision the app‑service principal + bootstrap secret (ops)

Two secrets, two jobs (`CHESSMASTER_LAUNCH_INTEGRATION.md` §credentials):

- **Ed25519 keypair + `client_id`** → row in `app_service_principals` (`app_id`,
  `environment`, `deployment_id`, `client_id`, `public_key`, `status='active'`,
  `valid_from`/`valid_until`). BabySteps holds only the public key
  (`src/lib/app-launch/principal.ts`). The app holds the private key and signs its
  exchange assertion with it.
- **`APP_LAUNCH_BOOTSTRAP_SECRET`** (HS256, 32+ chars) → set as an env var on *both*
  sides. BabySteps signs the bootstrap assertion with it
  (`src/lib/app-launch/service.ts:185`); the app verifies it.

> **Gap:** no code path inserts `app_service_principals` — provisioned out of band, same
> as `ci-deployer`.

### 9. Parent subscription (browser, parent)

`/account/subscriptions/new` — parent checks out a subscription for the product and
assigns it to a specific learner. This drives `learner_app_effective_entitlements`,
which is what `composeLearnerHome` scans to decide an app is even a candidate card.

### 10. Learner mode (browser, learner, WebAuthn)

`/account/learners/{id}/unlock` mounts `PasskeyUnlock` (IA‑004). The learner completes a
platform‑authenticator ceremony to get a `learner_mode` session. **This ceremony can't
be automated in the Claude‑in‑Chrome environment** — every prior verification session
hit this. Manual testing only.

### 11. Create the session — **the missing route (LP‑004)**

`startLearnerSession()` (`src/lib/learning-session/gateway.ts:230`) is fully built and
tested but **has no HTTP caller anywhere in `src/app`.** Every existing
`/v1/learner-sessions/*` route (`launch-dispatch`, `technical-credit`, `cancel-start`)
operates on a `[sessionId]` that must already exist. Nothing in production creates it.

`startLearnerSession` needs a `StartInput` whose `deployment` object is exactly what
`getPublishedDeployment(appId, environment)` returns (deploymentId, releaseId,
environment, origin, launchPath, compatibilityPassed, dispatchBlocked) — so wiring that
is trivial. The one real design question is the **schedule‑authorization gate**:

```ts
if (!technicalCredit && !input.scheduleAuthorized) throw APP_SESSION_NOT_SCHEDULED;
```

`scheduleAuthorized` / `scheduleAuthorizationId` has **no producer anywhere in `src/`**.
It was designed for a "one pre‑scheduled weekly slot per app" model (AR‑002 s2 spec
language) that the product did not build — UL‑001 shipped an always‑live launcher
instead. Options for the route:

- **A (recommended):** treat a `canStart` learner‑home card as the authorization — the
  route calls `composeLearnerHome`/`evaluateAccessFresh` + credit checks (which
  `startLearnerSession` already re‑does inside its own transaction anyway), and passes
  `scheduleAuthorized: true` with a synthesized `scheduleAuthorizationId` like
  `launcher:{learnerId}:{appId}:{isoWeek}`. No new subsystem, matches the shipped
  always‑live model.
- **B:** build the pre‑scheduling subsystem (new table, parent/learner "book a session"
  UI, a producer for the authorization). Large; only worth it if the product actually
  wants scheduled slots.
- **C:** ship the route supporting only `technical_credit` funding first (no gate),
  defer normal/standard. Unblocks nothing for a normal launch.

### 12–14. Dispatch + exchange (already built)

`POST /v1/learner-sessions/{id}/launch-dispatch` → `dispatchAppLaunch` mints a one‑time
`launchCode` + `launchAttemptId`, returns an auto‑submitting HTML form posting them to
`{verified_origin}{launchPath}` (the app's `/launch`). The app then calls
`POST /v1/internal/app-launch/exchange` with header `x-babysteps-app-assertion` (its
60‑second Ed25519 JWT) and `{launchCode, launchAttemptId, exchangeIdempotencyKey}`, and
gets back `{bootstrapAssertion, bootstrapExpiresAt, centralSessionExpiresAt,
platformApiAccess}`. It verifies the HS256 `bootstrapAssertion` with the shared secret,
reads the learner claims, starts its local session, renders the game, and confirms
usable launch via `POST /v1/internal/learner-sessions/{id}/usable-launch`.

---

## ChessMasters — exact remaining work to first launch

1. **Cut a `ci-deployer` release for `ed47bae`** (ops/automation). `/health` now returns
   200 so staging verification should pass this time.
2. **Reauth + Schedule production deployment** for the newly‑verified release (Sridhar,
   in `/admin/apps/2caee1f3-.../deployments`).
3. **Provision** ChessMaster's `app_service_principals` row (Ed25519 public key,
   `deployment_id` from step 2) and set `APP_LAUNCH_BOOTSTRAP_SECRET` + `client_id` +
   private key on ChessMaster's Vercel. (`POST /launch` currently 500s
   "not configured to accept launches yet" for exactly this reason.)
4. **Build `POST /v1/learner-sessions`** (LP‑004) — option A above. New route + entry in
   `route-actions.ts` (both the handler guard and the middleware allowlist —
   `API_ROUTE_AUTHORIZATION`) + tests + wire the `/learner` "Start" button to it.
5. **Parent**: buy a chess‑masters subscription, assign to a learner.
6. **Learner**: unlock learner mode (manual — WebAuthn), tap Open.

Steps 1–3 are ops/staff and password‑gated. Step 4 is this repo. Steps 5–6 are manual
product testing.

---

## Making this simpler for the next app

The pipeline is sound; the friction is that four of the steps have **no first‑class
entry point** and rely on out‑of‑band runs. Concrete improvements, roughly in
value order:

1. **One onboarding script** (`scripts/onboard-app.mjs`) that, given `appKey`,
   `vercelTeamId`, `vercelProjectId`, `repo`, and a `ci-deployer` assertion:
   registers → activates → binds staging+production → cuts the first release →
   prints the exact "schedule production" URL for a human to finish. Turns steps 1,
   2, 3, 5 into one command.
2. **Seed the `ci-deployer` / `scheduler` / `deployment-scheduler`
   `platform_service_principals` rows from a checked‑in bootstrap** (like
   `bootstrapFirstPlatformAdministrator` does for staff), or a
   `scripts/seed-service-principals.mjs`, so cutting a release doesn't need an
   out‑of‑band identity.
3. **An admin "Provision app credentials" action** on the app‑deployments page:
   generates the Ed25519 keypair + `client_id`, writes the `app_service_principals`
   row bound to the current published `deployment_id`, and shows the private key +
   bootstrap secret **once** for the operator to copy into the partner's env. Removes
   the only fully‑manual DB‑insert step.
4. **A "retry verification" button** on a `staging_failed` release, so an app that
   fixed its `/health` doesn't need a brand‑new release just to re‑run the gate.
5. **Build LP‑004 `POST /v1/learner-sessions`** (option A) — after which the
   learner‑facing launch is fully wired and every future app inherits it for free.
6. **A staff "dry‑run launch" tool**: given an app + a test learner with entitlement,
   run steps 11→14 server‑side and report where it breaks — so app onboarding can be
   verified without needing a real WebAuthn learner‑mode ceremony.

Items 1–4 are independent and small. Item 5 is the one real feature build. Item 6
makes every future onboarding self‑verifying.
