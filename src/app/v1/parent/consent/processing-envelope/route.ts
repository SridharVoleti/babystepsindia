import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import {
  hasCurrentProcessingEnvelopeConsent, recordProcessingEnvelopeConsent, PROCESSING_ENVELOPE_VERSION,
} from "@/lib/db/consent";

// PC-002: the escape hatch a material processing-envelope version bump
// requires — without this route, a parent whose consent is now stale
// would be permanently blocked from checkout (rule: "required processing
// fails closed without current consent") with no way to grant fresh
// affirmative consent. Every subscribed app/provider inside the same
// envelope is covered by this one parent-level grant (never a second,
// per-app consent flow).
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.consent.processing_envelope.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({
    currentVersion: PROCESSING_ENVELOPE_VERSION,
    hasCurrentConsent: hasCurrentProcessingEnvelopeConsent(guard.parent.session.sub),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.consent.processing_envelope.update");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`consent-processing-envelope:${guard.parent.session.sub}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  recordProcessingEnvelopeConsent(guard.parent.session.sub);
  return NextResponse.json({ currentVersion: PROCESSING_ENVELOPE_VERSION, hasCurrentConsent: true },
    { headers: { "Cache-Control": "no-store" } });
}
