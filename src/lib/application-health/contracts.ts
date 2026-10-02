export const APPLICATION_HEALTH_CAPABILITIES = [
  "billing",
  "entitlement_access",
  "progress",
  "notification",
  "scheduled_processing",
  "privacy_deletion",
  "app_platform_contract",
  "data_integrity",
  "critical_provider",
] as const;

export type ApplicationHealthCapability = typeof APPLICATION_HEALTH_CAPABILITIES[number];
export type ApplicationHealthSeverity = "recoverable" | "major" | "critical";

export interface ApplicationHealthSignal {
  capability: ApplicationHealthCapability;
  issueKey: string;
  impact: string;
  firstObservedAt: string;
  lastObservedAt: string;
  consecutiveFailures: number;
  recoveryAttempts: number;
  recoveryExhausted: boolean;
  degraded: boolean;
  critical?: boolean;
  safeDiagnosticCode: string;
  correlationId?: string;
}

export interface ClassifiedApplicationHealth {
  capability: ApplicationHealthCapability;
  issueKey: string;
  dedupeKey: string;
  severity: ApplicationHealthSeverity;
  shouldAlert: boolean;
  impact: string;
  firstObservedAt: string;
  lastObservedAt: string;
  durationSeconds: number;
  recoveryState: "recovering" | "degraded" | "exhausted";
  recoveryAttempts: number;
  safeDiagnosticCode: string;
  correlationId?: string;
}

const SAFE_DIAGNOSTIC = /^[A-Z0-9_]{1,64}$/;
const SAFE_CORRELATION = /^[A-Za-z0-9._:-]{1,96}$/;

function secondsBetween(first: string, last: string): number {
  const value = Math.floor((Date.parse(last) - Date.parse(first)) / 1000);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function classifyApplicationHealth(signal: ApplicationHealthSignal): ClassifiedApplicationHealth {
  if (!APPLICATION_HEALTH_CAPABILITIES.includes(signal.capability)) throw new Error("Unsupported application-health capability");
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(signal.issueKey)) throw new Error("Unsafe application-health issue key");
  if (!SAFE_DIAGNOSTIC.test(signal.safeDiagnosticCode)) throw new Error("Unsafe diagnostic classification");
  if (signal.correlationId && !SAFE_CORRELATION.test(signal.correlationId)) throw new Error("Unsafe correlation id");

  const severity: ApplicationHealthSeverity = !signal.recoveryExhausted
    ? "recoverable"
    : signal.critical
      ? "critical"
      : "major";

  return {
    capability: signal.capability,
    issueKey: signal.issueKey,
    dedupeKey: `${signal.capability}:${signal.issueKey}`,
    severity,
    shouldAlert: severity === "critical" || (severity === "major" && signal.consecutiveFailures >= 3),
    impact: signal.impact,
    firstObservedAt: signal.firstObservedAt,
    lastObservedAt: signal.lastObservedAt,
    durationSeconds: secondsBetween(signal.firstObservedAt, signal.lastObservedAt),
    recoveryState: signal.recoveryExhausted ? "exhausted" : signal.degraded ? "degraded" : "recovering",
    recoveryAttempts: Math.max(0, signal.recoveryAttempts),
    safeDiagnosticCode: signal.safeDiagnosticCode,
    ...(signal.correlationId ? { correlationId: signal.correlationId } : {}),
  };
}

export function safeUserMessage(_diagnosticCode: string): string {
  return "This service is temporarily unavailable. Please try again shortly.";
}
