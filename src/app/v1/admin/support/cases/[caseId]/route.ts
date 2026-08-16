import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getSupportCase, updateSupportCaseWorkflow } from "@/lib/support-cases/service";
import { composeCaseSnapshotSections } from "@/lib/support-cases/snapshot";
import { SupportCaseError, supportCaseErrorStatus, SUPPORT_CASE_CATEGORIES, SUPPORT_CASE_STATUSES,
  SUPPORT_CASE_PRIORITIES, ESCALATION_ROLES } from "@/lib/support-cases/contracts";

// API-AD-013: category-limited safe snapshot. A foreign/unowned case ID
// fails the same way a genuinely missing one does (rule 40, 86).
export async function GET(_request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.case.read");
  if (!guard.ok) return guard.response;
  try {
    const kase = getSupportCase(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys }, params.caseId);
    const sections = composeCaseSnapshotSections(params.caseId);
    return NextResponse.json({
      caseId: kase.id, category: kase.category, status: kase.status, priority: kase.priority,
      assignedStaffAccountId: kase.assigned_staff_account_id, escalationRole: kase.escalation_role,
      version: kase.version, createdAt: kase.created_at, updatedAt: kase.updated_at, closedAt: kase.closed_at,
      ...sections,
    }, { headers: { "Cache-Control": "private, no-cache", ETag: `"${kase.version}"` } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}

// API-AD-014: workflow status/category/assignment/escalation/priority only
// — never a source-domain mutation.
export async function PATCH(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.case.workflow_update");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (!Number.isInteger(body.expectedVersion) || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.status !== undefined && !(SUPPORT_CASE_STATUSES as readonly string[]).includes(body.status as string)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.category !== undefined && !(SUPPORT_CASE_CATEGORIES as readonly string[]).includes(body.category as string)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.priority !== undefined && !(SUPPORT_CASE_PRIORITIES as readonly string[]).includes(body.priority as string)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.escalationRole !== undefined && body.escalationRole !== null &&
    !(ESCALATION_ROLES as readonly string[]).includes(body.escalationRole as string)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = updateSupportCaseWorkflow(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys }, params.caseId,
      {
        expectedVersion: body.expectedVersion as number, idempotencyKey: body.idempotencyKey,
        status: body.status as never, category: body.category as never,
        assignedStaffAccountId: body.assignedStaffAccountId as never, escalationRole: body.escalationRole as never,
        priority: body.priority as never,
      },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}
