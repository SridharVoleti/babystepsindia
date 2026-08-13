import { composeParentAttentionBadge } from "@/lib/parent-attention/service";
import type { ParentAttentionBadge } from "@/lib/parent-attention/contracts";

export type ParentShellContext = {
  composedAt: string;
  version: string;
  attentionBadge: ParentAttentionBadge;
};

// PD-004: the shell owns navigation/presentation only — parent identity
// (email) is already carried on the authenticated session and read
// directly by callers; this composer's only job is the canonical
// attention badge (PD-003's composeParentAttentionBadge, never a second
// shell-local attention calculation).
export function composeParentShellContext(parentId: string, now: Date): ParentShellContext {
  const attentionBadge = composeParentAttentionBadge(parentId, now);
  return { composedAt: attentionBadge.composedAt, version: attentionBadge.version, attentionBadge };
}
