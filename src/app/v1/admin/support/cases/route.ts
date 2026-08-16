import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { createSupportCase, listSupportCases } from "@/lib/support-cases/service";
import { SupportCaseError, supportCaseErrorStatus, SUPPORT_CASE_CATEGORIES, SUPPORT_CASE_STATUSES } from "@/lib/support-cases/contracts";

// API-AD-011: create an exact parent-bound case from a valid resolver receipt.
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.support.case.create");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.receiptId !== "string" || typeof body.category !== "string" ||
    !(SUPPORT_CASE_CATEGORIES as readonly string[]).includes(body.category) ||
    typeof body.reason !== "string" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = createSupportCase(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      { receiptId: body.receiptId, category: body.category as never, reason: body.reason, idempotencyKey: body.idempotencyKey },
    );
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}

// API-AD-012: list permitted cases, not customers — scoped before pagination.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.support.case.list");
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  if (status && !(SUPPORT_CASE_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (category && !(SUPPORT_CASE_CATEGORIES as readonly string[]).includes(category)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = listSupportCases(
    { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
    {
      status: status as never, category: category as never,
      assignedToMe: url.searchParams.get("assignedToMe") === "true",
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    },
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
