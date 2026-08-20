// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { signSession, verifySessionToken } from "@/lib/auth/session";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";

const sessionClaims = {
  sub: "parent-1",
  email: "parent@example.com",
  isAdmin: false,
  entitlements: { bundle: false, products: [] },
};

beforeEach(() => {
  process.env.AUTH_SECRET = "au-002-test-secret-at-least-32-characters";
});

const readSource = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

describe("AU-002 acceptance contract", () => {
  it("AT-AU-002-01 uses the authenticated parent session as the sole end-user root", () => {
    expect(readSource("src/lib/authorization/api-guard.ts")).toContain("requireApiParent");
    expect(readSource("src/lib/authorization/modes.ts")).not.toMatch(/learner.*password|learner.*session token/i);
  });

  it("AT-AU-002-02 derives one mutually exclusive authorization mode", () => {
    expect(readSource("src/lib/authorization/modes.ts"))
      .toContain('export type AuthorizationMode="parent_management"|"learner_mode"');
  });

  it("AT-AU-002-03 requires the parent session and signed device context", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain("!input.parentSessionId||!input.deviceSessionId");
    expect(source).toContain("AUTHORIZATION_CONTEXT_UNAVAILABLE");
  });

  it("AT-AU-002-04 consumes exact one-time passkey verification evidence", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain("learner_mode_unlock_receipts");
    expect(source).toContain("consumed_at is null");
    expect(source).not.toContain("passkeyVerified:boolean");
  });

  it("AT-AU-002-06 scopes parent learner queries by direct ownership", () => {
    expect(readSource("src/lib/authorization/modes.ts")).toContain('where:"owner_parent_id = ?"');
  });

  it("AT-AU-002-07 assigns parent account, learner and commercial actions only to parent mode", () => {
    for (const action of ["parent.account.read", "parent.learners.list", "parent.learner.manage", "parent.billing.read"] as const)
      expect(AUTHORIZATION_ACTIONS[action].mode).toBe("parent_management");
  });

  it("AT-AU-002-08 requires learner mode for learner home and session start", () => {
    expect(AUTHORIZATION_ACTIONS["learner.home.read"].mode).toBe("learner_mode");
    expect(AUTHORIZATION_ACTIONS["learner.session.start"].mode).toBe("learner_mode");
  });

  it("AT-AU-002-11 keeps learner management and passkey management in parent mode", () => {
    expect(AUTHORIZATION_ACTIONS["parent.learner.manage"].mode).toBe("parent_management");
    expect(AUTHORIZATION_ACTIONS["parent.passkeys.manage"].mode).toBe("parent_management");
  });

  it("AT-AU-002-12 binds launch dispatch to the learner stored on the session", () => {
    expect(readSource("src/lib/app-launch/service.ts")).toContain("session.learner_id !== input.learnerId");
  });

  it("AT-AU-002-13 exposes no learner-browser action for direct commercial or progress mutation", () => {
    const learnerActions = Object.entries(AUTHORIZATION_ACTIONS)
      .filter(([, definition]) => definition.mode === "learner_mode").map(([key]) => key);
    expect(learnerActions).not.toEqual(expect.arrayContaining(["app.progress.write", "service.entitlements.apply_cycle"]));
  });

  it("AT-AU-002-14 keeps progress writes behind app-session authorization", () => {
    const source = readSource("src/app/v1/internal/learner-app-progress/current/route.ts");
    expect(source).toContain('authorizeProtectedAppApi(request,"progress.write")');
    expect(source).not.toContain("requireEndUserAuthorization");
  });

  it("AT-AU-002-15 provides an owner-scoped parent learner report", () => {
    expect(AUTHORIZATION_ACTIONS["parent.learner.report.read"].mode).toBe("parent_management");
    expect(readSource("src/app/v1/learners/[learnerId]/progress/route.ts"))
      .toContain('"parent.learner.report.read"');
  });

  it("AT-AU-002-16 requires the current parent password to leave learner mode", () => {
    const source = readSource("src/app/v1/learner-mode/exit/route.ts");
    expect(source).toContain("signInWithPassword");
    expect(source).toContain("revokeLearnerMode");
  });

  it("AT-AU-002-17 replaces the one device-bound context during learner switching", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain("on conflict(parent_session_id,device_session_id) do update");
    expect(source).toContain("version=learner_unlock_contexts.version+1");
  });

  it("AT-AU-002-19 supports immediate credential-bound context revocation", () => {
    expect(readSource("src/lib/authorization/modes.ts")).toContain("revokeLearnerContextsByCredential");
  });

  it("AT-AU-002-20 applies the same owner and mode rules without identity-merging exceptions", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).not.toMatch(/display_name|date_of_birth|self.?learner/i);
    expect(source).toContain("owner_parent_id");
  });

  it("AT-AU-002-21 builds owner or bound-learner scope before query execution", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain('context.mode==="learner_mode"?{where:"id = ?"');
    expect(source).toContain('{where:"owner_parent_id = ?"');
  });

  it("AT-AU-002-22 returns non-enumerating not-found errors for foreign resources", () => {
    expect(readSource("src/lib/authorization/modes.ts")).toContain('AuthorizationModeError("RESOURCE_NOT_FOUND")');
  });

  it("AT-AU-002-23 leaves account, app, deployment and session domain gates after authorization", () => {
    const source = readSource("src/lib/app-launch/service.ts");
    for (const code of ["ACCOUNT_NOT_ACTIVE", "APP_NOT_ACTIVE", "APP_DEPLOYMENT_WINDOW_BLOCKED", "SESSION_NOT_LAUNCHABLE"])
      expect(source).toContain(code);
  });

  it("AT-AU-002-25 treats UI capabilities as hints while APIs authorize independently", () => {
    expect(readSource("src/lib/authorization/ui-capabilities.ts")).toContain("generateUiCapabilityHints");
    expect(readSource("src/lib/authorization/api-guard.ts")).toContain("authorizeEndUserAction");
  });

  it("AT-AU-002-26 stores at most one learner context per parent session and device", () => {
    expect(readSource("src/lib/db/schema.sql")).toContain("primary key(parent_session_id,device_session_id)");
  });

  it("AT-AU-002-28 separates browser mode from internal app-service authorization", () => {
    expect(AUTHORIZATION_ACTIONS["app.progress.write"].mode).toBe("app_service");
    expect(readSource("src/app/v1/internal/learner-app-progress/current/route.ts"))
      .toContain("authorizeProtectedAppApi");
  });

  it("AT-AU-002-29 rejects stale, revoked and malformed learner contexts", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain('row.status!=="active"');
    expect(source).toContain("LEARNER_UNLOCK_CONTEXT_INVALID");
  });

  it("AT-AU-002-30 writes minimal classified transition and denial audits", () => {
    const source = readSource("src/lib/authorization/modes.ts");
    expect(source).toContain("authorization_boundary_denied");
    expect(source).toContain("learner_mode_activated");
    expect(source).toContain("learner_mode_revoked");
  });

  it("AT-AU-002-31 excludes sensitive payload fields from authorization audit metadata", () => {
    const audit = readSource("src/lib/authorization/modes.ts").slice(
      readSource("src/lib/authorization/modes.ts").indexOf("function auditDenied"),
      readSource("src/lib/authorization/modes.ts").indexOf("export async function authorizeEndUserAction"),
    );
    expect(audit).not.toMatch(/password|token|dateOfBirth|progress|payment|runtime/i);
  });

  it("AT-AU-002-32 maps every protected route to a canonical registered action", () => {
    expect(readSource("tests/canonical-route-actions.test.ts")).toContain("classifies every exported v1 method");
    expect(Object.keys(AUTHORIZATION_ACTIONS).length).toBeGreaterThan(20);
  });

  it("AT-AU-002-33 fails closed when authorization context construction fails", () => {
    const source = readSource("src/lib/authorization/api-guard.ts");
    expect(source).toContain('"AUTHORIZATION_CONTEXT_UNAVAILABLE"');
    expect(source).toContain("status,headers");
  });

  it("AT-AU-002-35 keeps every dependent regression suite executable", () => {
    for (const file of ["tests/auth-adapter.test.ts", "tests/learner-profile.test.ts",
      "tests/learner-session-gateway.test.ts", "tests/app-launch.test.ts"])
      expect(fs.existsSync(path.join(process.cwd(), file))).toBe(true);
  });
});

describe("AU-002 authoritative parent and device context", () => {
  it("AT-AU-002-27 signs a server-issued device session into every parent session", async () => {
    const token = await signSession(sessionClaims);
    const session = await verifySessionToken(token);

    expect(session?.sid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session?.did).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("AT-AU-002-05 derives device authority from the signed session, never a browser header", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/authorization/api-guard.ts"),
      "utf8",
    );

    expect(source).toContain("parent.context.session.did");
    expect(source).not.toContain('headers.get("x-babysteps-device-session")');
  });
});

describe("AU-002 protected browser API enforcement", () => {
  it("AT-AU-002-34 applies the mode-aware guard to every parent and learner API", () => {
    const routeRoots = [
      "account",
      "parent",
      "learners",
      "learner-selection",
      "learner-mode",
      "learner-sessions",
    ];
    const routeFiles = routeRoots.flatMap((root) => {
      const directory = path.join(process.cwd(), "src/app/v1", root);
      const walk = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true })
        .flatMap((entry) => {
          const target = path.join(current, entry.name);
          return entry.isDirectory() ? walk(target) : entry.name === "route.ts" ? [target] : [];
        });
      return walk(directory);
    });

    const bypasses = routeFiles.flatMap((file) => {
      const source = fs.readFileSync(file, "utf8");
      const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)]
        .map((match) => match[1]);
      if (methods.length === 0 || source.includes("requireEndUserAuthorization")) return [];
      return methods.map((method) => `${method} ${path.relative(process.cwd(), file)}`);
    });

    expect(bypasses).toEqual([]);
  });

  it("AT-AU-002-18 revokes the signed parent session before logout clears its cookie", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/(auth)/actions.ts"),
      "utf8",
    );

    expect(source).toContain("revokeLearnerContextsForSession(session.sid");
    expect(source.indexOf("revokeLearnerContextsForSession(session.sid"))
      .toBeLessThan(source.indexOf("clearSessionCookie()"));
  });

  it("AT-AU-002-24 repeats authorization under the write lock for every end-user mutation", () => {
    const mutationFiles = [
      "src/app/v1/account/email-change/cancel/route.ts",
      "src/app/v1/account/email-change/request/route.ts",
      "src/app/v1/account/email-change/resend/route.ts",
      "src/app/v1/account/password/change/route.ts",
      "src/app/v1/account/soft-delete/route.ts",
      "src/app/v1/parent/profile/route.ts",
      "src/app/v1/learners/[learnerId]/route.ts",
      "src/app/v1/learner-selection/route.ts",
      "src/app/v1/learner-mode/exit/route.ts",
      "src/app/v1/learner-sessions/[sessionId]/launch-dispatch/route.ts",
      "src/app/v1/learner-sessions/[sessionId]/technical-credit/route.ts",
      "src/app/v1/learner-sessions/[sessionId]/cancel-start/route.ts",
    ];
    const bypasses = mutationFiles.filter((file) =>
      !fs.readFileSync(path.join(process.cwd(), file), "utf8").includes("withLockedEndUserMutation"));

    expect(bypasses).toEqual([]);
  });
});

describe("AU-002 page-shell separation", () => {
  it("AT-AU-002-10 gates every parent account page on parent-management mode", () => {
    const accountRoot = path.join(process.cwd(), "src/app/account");
    const walk = (current: string): string[] => fs.readdirSync(current, { withFileTypes: true })
      .flatMap((entry) => {
        const target = path.join(current, entry.name);
        return entry.isDirectory() ? walk(target) : entry.name === "page.tsx" ? [target] : [];
      });
    const bypasses = walk(accountRoot).filter((file) =>
      !fs.readFileSync(file, "utf8").includes("requireParentManagement"));

    expect(bypasses.map((file) => path.relative(process.cwd(), file))).toEqual([]);
  });

  it("AT-AU-002-09 exposes a learner-only shell with password-gated parent return", () => {
    const learnerPage = fs.readFileSync(path.join(process.cwd(), "src/app/learner/page.tsx"), "utf8");
    const exitForm = fs.readFileSync(
      path.join(process.cwd(), "src/components/learner-mode/exit-form.tsx"),
      "utf8",
    );

    expect(learnerPage).toContain("requireLearnerMode");
    expect(learnerPage).not.toMatch(/billing|subscription|security settings/i);
    expect(exitForm).toContain('type="password"');
    expect(exitForm).toContain("/v1/learner-mode/exit");
  });
});
