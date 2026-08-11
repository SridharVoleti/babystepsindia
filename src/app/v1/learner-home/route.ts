import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { generateUiCapabilityHints } from "@/lib/authorization/ui-capabilities";
import { LAUNCHER_REFRESH_REASONS, type LauncherRefreshReason } from "@/lib/learner-home/contracts";

function refreshReason(request: Request): LauncherRefreshReason {
  const candidate = request.headers.get("x-launcher-refresh-reason");
  return LAUNCHER_REFRESH_REASONS.find((reason) => reason === candidate) ?? "page_entry";
}

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// UL-001: the learner is server-derived from the exact learner_mode
// context — never a client-supplied id, param or body (rules 1-5). Reads
// only; no session/credit/mutation of any kind.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.home.read");
  if (!guard.ok) return guard.response;
  const learnerId = guard.authorization.learnerId!;
  const now = new Date();
  const contextVersion = guard.authorization.contextVersion ?? 0;
  const home = composeLearnerHome(learnerId, "production", now, contextVersion);
  const capabilities = generateUiCapabilityHints({ principal: guard.principal,
      candidateActions: ["learner.session.start", "learner.session.resume", "learner.mode.exit"],
      resource: { learnerId } });
  // Context generation is repeated in the validator even though the
  // composed launcherVersion already includes it. This makes cross-context
  // 304 reuse structurally impossible at the HTTP boundary.
  const etag = `"${home.launcherVersion}.${contextVersion}"`;
  const reason = refreshReason(request);
  const headers = new Headers({
    "Cache-Control": "private, no-cache",
    ETag: etag,
    Vary: "Cookie",
    "X-Launcher-Version": home.launcherVersion,
    "X-Launcher-Context-Version": String(contextVersion),
    "X-Launcher-Server-Time": home.serverTime ?? now.toISOString(),
    "X-Launcher-Composed-At": home.composedAt ?? now.toISOString(),
    "X-Launcher-Cache-Max-Age": String(home.cacheMaxAgeSeconds ?? 60),
    "X-Launcher-Refresh-Reason": reason,
  });
  if (home.nextRecheckAt) headers.set("X-Launcher-Next-Recheck-At", home.nextRecheckAt);
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json({ ...home, capabilities }, { headers });
}
