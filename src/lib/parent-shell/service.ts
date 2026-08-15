import { createHash } from "node:crypto";
import { composeParentAttentionBadge } from "@/lib/parent-attention/service";
import type { ParentAttentionBadge } from "@/lib/parent-attention/contracts";
import { PARENT_NAV_ITEMS, PARENT_NAV_VERSION, type ParentShellNavItem } from "./nav";

export { PARENT_NAV_ITEMS, PARENT_NAV_VERSION, type ParentShellNavItem };

// PD-004 API-PD-006: capabilityHints are explicitly non-authoritative —
// every destination independently re-verifies (AT-PD-004-48). This app has
// no tiered parent permissions (a verified parent in parent_management can
// always manage their own learners/billing), so both hints are always true;
// they exist to match the frozen response schema, not to gate anything.
export type ParentShellCapabilityHints = {
  canManageBilling: boolean;
  canManageLearners: boolean;
};

export type ParentShellContext = {
  shellVersion: string;
  composedAt: string;
  modeGeneration: number;
  navItems: ParentShellNavItem[];
  attentionSummary?: ParentAttentionBadge;
  capabilityHints?: ParentShellCapabilityHints;
};

// PD-004 AC8/API-PD-006: attentionSummary failure must never fail the shell
// itself — isolated here, inside the composer, not only by callers (a prior
// version relied on account/layout.tsx's own try/catch, which left the
// shell-context API route itself unprotected).
function safeAttentionSummary(parentId: string, now: Date): ParentAttentionBadge | undefined {
  try {
    return composeParentAttentionBadge(parentId, now);
  } catch {
    return undefined;
  }
}

export function composeParentShellContext(parentId: string, modeGeneration: number, now: Date): ParentShellContext {
  const attentionSummary = safeAttentionSummary(parentId, now);
  const shellVersion = createHash("sha256")
    .update(JSON.stringify([PARENT_NAV_VERSION, modeGeneration, attentionSummary?.version ?? null]))
    .digest("hex")
    .slice(0, 32);
  return {
    shellVersion,
    composedAt: now.toISOString(),
    modeGeneration,
    navItems: [...PARENT_NAV_ITEMS],
    attentionSummary,
    capabilityHints: { canManageBilling: true, canManageLearners: true },
  };
}
