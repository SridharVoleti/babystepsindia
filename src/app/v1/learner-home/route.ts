import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { generateUiCapabilityHints } from "@/lib/authorization/ui-capabilities";

// UL-001: the learner is server-derived from the exact learner_mode
// context — never a client-supplied id, param or body (rules 1-5). Reads
// only; no session/credit/mutation of any kind.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.home.read");
  if (!guard.ok) return guard.response;
  const learnerId = guard.authorization.learnerId!;
  const home = composeLearnerHome(learnerId, "production", new Date());
  return NextResponse.json({ ...home,
    capabilities: generateUiCapabilityHints({ principal: guard.principal,
      candidateActions: ["learner.session.start", "learner.session.resume", "learner.mode.exit"],
      resource: { learnerId } }) },
  { headers: { "Cache-Control": "private, no-store" } });
}
