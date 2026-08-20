import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { raiseDeduplicatedAlert, resolveDeduplicatedAlert } from "@/lib/monitoring/alerting";

const ALERT_TYPE = "provider_backup_failure";

type BackupStatusPayload = { status: "completed" | "failed"; occurredAt: string; providerRef?: string };

function isValidPayload(body: unknown): body is BackupStatusPayload {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  if (record.status !== "completed" && record.status !== "failed") return false;
  if (typeof record.occurredAt !== "string" || Number.isNaN(Date.parse(record.occurredAt))) return false;
  if (record.providerRef !== undefined && typeof record.providerRef !== "string") return false;
  return true;
}

// BR-001: the integration point our own ops tooling calls to report the
// provider-native daily backup's own outcome — the exact upstream signal
// source (a provider webhook, or a scheduled status-check script) is an
// implementation detail decided once a real production project exists;
// this endpoint and the alerting it drives are ready either way. Never a
// custom backup/dump/PITR mechanism itself — this only ever reports on
// the provider-native backup's outcome (rule: "no PITR/custom backup
// stack").
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "backup-status-reporter");
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }
  if (!isValidPayload(body)) {
    return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
  }

  const now = new Date(body.occurredAt);
  if (body.status === "failed") {
    const result = await raiseDeduplicatedAlert({
      alertType: ALERT_TYPE,
      capabilityFamily: "critical_providers",
      severity: "critical",
      message: "The daily provider-native database backup reported a failure.",
      safeContext: body.providerRef ? { providerRef: body.providerRef } : {},
      now,
    });
    return NextResponse.json({ escalated: result.created }, { headers: { "Cache-Control": "no-store" } });
  }

  const result = await resolveDeduplicatedAlert(ALERT_TYPE, now);
  return NextResponse.json({ resolved: result.resolved > 0 }, { headers: { "Cache-Control": "no-store" } });
}
