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
  items: AttentionItem[];
  partialErrors: string[];
};

export type ParentAttentionBadge = {
  composedAt: string;
  version: string;
  actionRequiredCount: number;
  attentionCount: number;
  hasItems: boolean;
  preview: AttentionItem[];
};

export const ATTENTION_SEVERITY_ORDER: Record<AttentionSeverity, number> = {
  action_required: 0,
  attention: 1,
  info: 2,
};
