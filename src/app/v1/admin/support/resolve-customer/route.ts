import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { resolveCustomer } from "@/lib/support-cases/service";
import { SupportCaseError, supportCaseErrorStatus, LOOKUP_IDENTIFIER_TYPES } from "@/lib/support-cases/contracts";

// API-AD-010: exact-match-only customer resolver. POST so identifiers never
// enter URL/query logs (rule 20); rate-limited and reason-audited (rule 22).
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.support.resolve_customer");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`support-resolve-customer:${guard.session.sub}`, 20, 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.identifierType !== "string" ||
    !(LOOKUP_IDENTIFIER_TYPES as readonly string[]).includes(body.identifierType) ||
    typeof body.identifierValue !== "string" || !body.identifierValue.trim() ||
    typeof body.reason !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = resolveCustomer(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      { identifierType: body.identifierType as never, identifierValue: body.identifierValue, reason: body.reason },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}
