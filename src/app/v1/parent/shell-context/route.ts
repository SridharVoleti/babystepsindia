import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentShellContext } from "@/lib/parent-shell/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// PD-004: no shell mutation endpoint exists — this is the only route the
// nav shell reads, and it never writes.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.shell_context.read");
  if (!guard.ok) return guard.response;
  const context = composeParentShellContext(guard.parent.session.sub, new Date());
  const etag = `"${context.version}"`;
  const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(context, { headers });
}
