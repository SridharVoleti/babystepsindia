// Source-inspection acceptance test for the IA-004 HTTP surface, matching
// the convention used by tests/au-002.acceptance.test.ts for other
// parent-authenticated (cookie-session, requireApiParent) routes: exercising
// them end-to-end requires a live Next.js request context for cookies(),
// which this suite doesn't spin up — so route wiring is verified by source
// inspection here, while the actual WebAuthn/authorization business logic is
// covered live in tests/ia-004-webauthn.test.ts and
// tests/canonical-route-actions.test.ts confirms every route below is
// correctly registered in the authorization action registry.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { API_ROUTE_AUTHORIZATION } from "@/lib/authorization/route-actions";

const readSource = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), "utf8");

describe("IA-004 WebAuthn HTTP surface", () => {
  it("gates passkey management routes on parent.passkeys.manage in parent_management mode", () => {
    expect(AUTHORIZATION_ACTIONS["parent.passkeys.manage"].mode).toBe("parent_management");
    for (const relative of [
      "src/app/v1/learners/[learnerId]/passkeys/route.ts",
      "src/app/v1/learners/[learnerId]/passkeys/registration-options/route.ts",
      "src/app/v1/learners/[learnerId]/passkeys/registration-verify/route.ts",
      "src/app/v1/learners/[learnerId]/passkeys/[credentialId]/revoke/route.ts",
    ]) {
      expect(readSource(relative)).toContain('"parent.passkeys.manage"');
    }
  });

  it("gates learner-mode entry on a dedicated parent_management action, not learner_mode", () => {
    expect(AUTHORIZATION_ACTIONS["learner.mode.enter"].mode).toBe("parent_management");
    expect(readSource("src/app/v1/learner-mode/enter/options/route.ts")).toContain('"learner.mode.enter"');
    expect(readSource("src/app/v1/learner-mode/enter/verify/route.ts")).toContain('"learner.mode.enter"');
  });

  it("establishes the learner selection context when issuing an unlock challenge", () => {
    // activateLearnerMode (on verify) fail-closes unless a live
    // learner_selection_contexts row exists for the (session, learner)
    // pair. The "Open learner" UI has no separate selection step, so the
    // options route must create it — otherwise the passkey verifies but
    // entering learner mode dies with RESOURCE_NOT_FOUND.
    const source = readSource("src/app/v1/learner-mode/enter/options/route.ts");
    expect(source).toContain("selectLearner");
    expect(source).toMatch(/selectLearner\([^)]*body\.learnerId/);
  });

  it("routes every ceremony step through the real WebAuthn service, not a stubbed boolean", () => {
    expect(readSource("src/app/v1/learners/[learnerId]/passkeys/registration-options/route.ts"))
      .toContain("generatePasskeyRegistrationOptions");
    expect(readSource("src/app/v1/learners/[learnerId]/passkeys/registration-verify/route.ts"))
      .toContain("verifyPasskeyRegistration");
    expect(readSource("src/app/v1/learner-mode/enter/options/route.ts")).toContain("generatePasskeyAuthenticationOptions");
    const verify = readSource("src/app/v1/learner-mode/enter/verify/route.ts");
    expect(verify).toContain("verifyPasskeyAuthenticationAndEnterLearnerMode");
    expect(verify).not.toContain("passkeyVerified:");
  });

  it("requires the current parent password before revoking a credential (GAP-073 reauth-protected lifecycle)", () => {
    const source = readSource("src/app/v1/learners/[learnerId]/passkeys/[credentialId]/revoke/route.ts");
    expect(source).toContain("signInWithPassword");
    expect(source).toContain("revokeLearnerPasskey");
  });

  it("registers every IA-004 route in the canonical action registry", () => {
    const patterns = API_ROUTE_AUTHORIZATION.map((rule) => rule.pattern.source);
    for (const fragment of ["passkeys$", "passkeys\\\\/registration-options$", "passkeys\\\\/registration-verify$",
      "passkeys\\\\/[^/]+\\\\/revoke$", "learner-mode\\\\/enter\\\\/options$", "learner-mode\\\\/enter\\\\/verify$"]) {
      expect(patterns.some((pattern) => pattern.includes(fragment.replaceAll("\\\\", "\\")))).toBe(true);
    }
  });
});
