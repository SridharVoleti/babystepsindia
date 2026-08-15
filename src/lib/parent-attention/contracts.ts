export type AttentionCategory = "billing" | "learner_setup" | "service_status" | "learning_cadence" | "access";
export type AttentionSeverity = "action_required" | "attention" | "info";

export type AttentionRoute = { href: string; label: string };

export type AttentionItem = {
  sourceKey: string;
  category: AttentionCategory;
  severity: AttentionSeverity;
  learnerId: string;
  learnerName: string;
  appId: string | null;
  appName: string | null;
  subscriptionId: string | null;
  title: string;
  message: string;
  route: AttentionRoute | null;
  effectiveAt: string | null;
  sourceVersion: string;
};

export type ParentAttentionResponse = {
  composedAt: string;
  version: string;
  // AT-PD-003-40: one bounded next-recheck boundary (the earliest upcoming
  // grace-window/maintenance-return timestamp across current items), never
  // a continuous-polling signal.
  nextRecheckAt: string | null;
  items: AttentionItem[];
  partialErrors: string[];
};

export type ParentAttentionBadge = {
  composedAt: string;
  version: string;
  actionRequiredCount: number;
  attentionCount: number;
  infoCount: number;
  hasItems: boolean;
  preview: AttentionItem[];
};

// API-PD-004's compact summary field (attentionVersion carried at the
// response's top level, not duplicated per-summary).
export type ParentAttentionSummaryCounts = {
  actionRequiredCount: number;
  attentionCount: number;
  infoCount: number;
};

export const ATTENTION_SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  action_required: 0,
  attention: 1,
  info: 2,
};
