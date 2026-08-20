import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { addSupportCaseNote, getSupportCase } from "@/lib/support-cases/service";
import { SupportCaseError, supportCaseErrorStatus } from "@/lib/support-cases/contracts";

// API-AD-015: append internal note — 1-4000 chars, no secrets, idempotent
// per (case, staff, idempotencyKey).
export async function POST(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.case.note.add");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.noteText !== "string" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const actor = { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys };
  try {
    await getSupportCase(actor, params.caseId); // scope check — same non-enumerating deny as GET
    const result = await addSupportCaseNote(actor, params.caseId, { noteText: body.noteText, idempotencyKey: body.idempotencyKey });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}
