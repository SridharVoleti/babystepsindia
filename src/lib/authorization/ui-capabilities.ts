import { getActiveAuthorizationPolicyBundle, AuthorizationPolicyBundleError } from "@/lib/authorization/policy-bundles";
import { authorizePrincipalAction, type AuthorizationPrincipal } from "@/lib/authorization/principals";
import type { AuthorizationAction } from "@/lib/authorization/modes";

export type UiCapabilityHints = {
  policyVersion: string | null;
  policyDigest: string | null;
  actions: AuthorizationAction[];
  issuedAt: string;
  expiresAt: string;
};

function bundlePrincipalType(principal: AuthorizationPrincipal) {
  return principal.type === "managed_service" ? "managed_service" : principal.type;
}

export function generateUiCapabilityHints(input: {
  principal: AuthorizationPrincipal;
  candidateActions: readonly AuthorizationAction[];
  resource?: { parentUserId?: string; learnerId?: string; appId?: string; learnerSessionId?: string };
  now?: Date;
  ttlSeconds?: number;
}): UiCapabilityHints {
  const now = input.now ?? new Date();
  const ttlSeconds = Math.max(1, Math.min(input.ttlSeconds ?? 30, 60));
  const base = { issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
  let bundle;
  try { bundle = getActiveAuthorizationPolicyBundle(); }
  catch (error) {
    if (error instanceof AuthorizationPolicyBundleError && error.code === "AUTHORIZATION_POLICY_INACTIVE")
      return { policyVersion: null, policyDigest: null, actions: [], ...base };
    throw error;
  }
  const actions = input.candidateActions.filter((action) => {
    const rule = bundle.rules.find((candidate) => candidate.actionKey === action
      && candidate.principalType === bundlePrincipalType(input.principal));
    if (!rule || rule.effect !== "allow") return false;
    try { authorizePrincipalAction(input.principal, action, input.resource); return true; }
    catch { return false; }
  });
  return { policyVersion: bundle.version, policyDigest: bundle.digest, actions, ...base };
}

export function isUiCapabilityHintCurrent(hints: Pick<UiCapabilityHints, "issuedAt" | "expiresAt">, now = new Date()) {
  const issuedAt = new Date(hints.issuedAt).getTime();
  const expiresAt = new Date(hints.expiresAt).getTime();
  return Number.isFinite(issuedAt) && Number.isFinite(expiresAt) && issuedAt <= now.getTime()
    && now.getTime() < expiresAt && expiresAt - issuedAt <= 60_000;
}
