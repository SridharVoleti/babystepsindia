import { AUTHORIZATION_ACTIONS, type AuthorizationAction, type EndUserAuthorizationContext } from "@/lib/authorization/modes";

export type ParentPrincipal = { type: "parent"; id: string; parentUserId: string; sessionId: string; deviceSessionId: string };
export type LearnerPrincipal = { type: "learner"; id: string; learnerId: string; parentUserId: string; sessionId: string; deviceSessionId: string; credentialId: string };
export type AdministratorPrincipal = { type: "administrator"; id: string; sessionId: string };
export type SupportPrincipal = { type: "support"; id: string; sessionId: string; permissions: readonly string[] };
export type ManagedServicePrincipal = { type: "managed_service"; id: string; serviceKind: "platform" | "learning_app"; appId?: string; learnerSessionId?: string };
export type AuthorizationPrincipal = ParentPrincipal | LearnerPrincipal | AdministratorPrincipal | SupportPrincipal | ManagedServicePrincipal;

export class PrincipalAuthorizationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "PrincipalAuthorizationError"; }
}
function verified(allowed: boolean) { if (!allowed) throw new PrincipalAuthorizationError("PRINCIPAL_NOT_VERIFIED"); }

export function principalFromEndUserContext(context: EndUserAuthorizationContext): ParentPrincipal | LearnerPrincipal {
  if (context.mode === "parent_management") return { type: "parent", id: context.parentUserId, parentUserId: context.parentUserId,
    sessionId: context.parentSessionId, deviceSessionId: context.deviceSessionId };
  if (!context.learnerId || !context.credentialId) throw new PrincipalAuthorizationError("PRINCIPAL_CONTEXT_INVALID");
  return { type: "learner", id: context.learnerId, learnerId: context.learnerId, parentUserId: context.parentUserId,
    sessionId: context.parentSessionId, deviceSessionId: context.deviceSessionId, credentialId: context.credentialId };
}
export function createAdministratorPrincipal(input: { id: string; sessionId: string; verified: boolean }): AdministratorPrincipal {
  verified(input.verified); return { type: "administrator", id: input.id, sessionId: input.sessionId };
}
export function createSupportPrincipal(input: { id: string; sessionId: string; verified: boolean; permissions: readonly string[] }): SupportPrincipal {
  verified(input.verified); return { type: "support", id: input.id, sessionId: input.sessionId, permissions: [...input.permissions] };
}
export function createManagedServicePrincipal(input: { id: string; verified: boolean; serviceKind: "platform" | "learning_app"; appId?: string; learnerSessionId?: string }): ManagedServicePrincipal {
  verified(input.verified); return { type: "managed_service", id: input.id, serviceKind: input.serviceKind,
    appId: input.appId, learnerSessionId: input.learnerSessionId };
}
export function authorizePrincipalAction(principal: AuthorizationPrincipal, action: AuthorizationAction,
  resource: { parentUserId?: string; learnerId?: string; appId?: string; learnerSessionId?: string } = {}) {
  const definition = AUTHORIZATION_ACTIONS[action];
  if (!definition) throw new PrincipalAuthorizationError("AUTHORIZATION_ACTION_UNKNOWN");
  const expected = definition.mode;
  const typeAllowed = (principal.type === "parent" && expected === "parent_management")
    || (principal.type === "learner" && expected === "learner_mode")
    || (principal.type === "administrator" && expected === "administrator")
    || (principal.type === "support" && expected === "support" && principal.permissions.includes(action))
    || (principal.type === "managed_service" && (expected === "service" || expected === "app_service")
      && (expected !== "app_service" || principal.serviceKind === "learning_app"));
  if (!typeAllowed) throw new PrincipalAuthorizationError("PRINCIPAL_TYPE_FORBIDDEN");
  if (principal.type === "parent" && resource.parentUserId && resource.parentUserId !== principal.parentUserId)
    throw new PrincipalAuthorizationError("RESOURCE_NOT_FOUND");
  if (principal.type === "learner" && resource.learnerId && resource.learnerId !== principal.learnerId)
    throw new PrincipalAuthorizationError("RESOURCE_NOT_FOUND");
  if (principal.type === "managed_service" && ((resource.appId && resource.appId !== principal.appId)
    || (resource.learnerSessionId && resource.learnerSessionId !== principal.learnerSessionId)))
    throw new PrincipalAuthorizationError("RESOURCE_NOT_FOUND");
  return { allowed: true as const, principalType: principal.type, principalId: principal.id, action };
}
