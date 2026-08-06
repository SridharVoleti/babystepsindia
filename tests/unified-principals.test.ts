import { describe, expect, it } from "vitest";
import {
  PrincipalAuthorizationError,
  authorizePrincipalAction,
  createAdministratorPrincipal,
  createManagedServicePrincipal,
  createSupportPrincipal,
  principalFromEndUserContext,
} from "@/lib/authorization/principals";

describe("AU-001 unified verified principals", () => {
  it("represents parent and nested learner identities without changing the parent root", () => {
    const parent = principalFromEndUserContext({ parentUserId: "parent-1", parentSessionId: "session-1",
      deviceSessionId: "device-1", mode: "parent_management" });
    expect(parent).toEqual({ type: "parent", id: "parent-1", parentUserId: "parent-1", sessionId: "session-1", deviceSessionId: "device-1" });
    expect(authorizePrincipalAction(parent, "parent.profile.read", { parentUserId: "parent-1" })).toMatchObject({ allowed: true });

    const learner = principalFromEndUserContext({ parentUserId: "parent-1", parentSessionId: "session-1",
      deviceSessionId: "device-1", mode: "learner_mode", learnerId: "learner-1", credentialId: "credential-1" });
    expect(learner).toMatchObject({ type: "learner", id: "learner-1", parentUserId: "parent-1" });
    expect(() => authorizePrincipalAction(learner, "parent.profile.read"))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_TYPE_FORBIDDEN"));
  });

  it("keeps administrator and support principals distinct", () => {
    const administrator = createAdministratorPrincipal({ id: "admin-1", sessionId: "admin-session", verified: true });
    expect(authorizePrincipalAction(administrator, "admin.app.read")).toMatchObject({ allowed: true });
    const support = createSupportPrincipal({ id: "support-1", sessionId: "support-session", verified: true,
      permissions: ["support.account.read"] });
    expect(authorizePrincipalAction(support, "support.account.read")).toMatchObject({ allowed: true });
    expect(() => authorizePrincipalAction(support, "admin.app.read"))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_TYPE_FORBIDDEN"));
  });

  it("binds managed services to their exact service/app/session authority", () => {
    const platform = createManagedServicePrincipal({ id: "analytics-service", verified: true, serviceKind: "platform" });
    expect(authorizePrincipalAction(platform, "service.analytics.run")).toMatchObject({ allowed: true });
    const app = createManagedServicePrincipal({ id: "app-principal-1", verified: true, serviceKind: "learning_app",
      appId: "app-1", learnerSessionId: "learner-session-1" });
    expect(authorizePrincipalAction(app, "app.progress.write", { appId: "app-1", learnerSessionId: "learner-session-1" }))
      .toMatchObject({ allowed: true });
    expect(() => authorizePrincipalAction(app, "app.progress.write", { appId: "other-app" }))
      .toThrowError(new PrincipalAuthorizationError("RESOURCE_NOT_FOUND"));
  });

  it("refuses unverified identities for every privileged principal type", () => {
    expect(() => createAdministratorPrincipal({ id: "claimed-admin", sessionId: "s", verified: false }))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_NOT_VERIFIED"));
    expect(() => createSupportPrincipal({ id: "claimed-support", sessionId: "s", verified: false, permissions: [] }))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_NOT_VERIFIED"));
    expect(() => createManagedServicePrincipal({ id: "claimed-service", verified: false, serviceKind: "platform" }))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_NOT_VERIFIED"));
  });
});
