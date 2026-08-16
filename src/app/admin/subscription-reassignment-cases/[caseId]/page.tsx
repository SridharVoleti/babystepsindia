import { requireAdminPermission } from "@/lib/auth/guards";
import { hasRecentAdminAuthentication } from "@/lib/auth/admin-api-guard";
import { getAdminReassignmentCase } from "@/lib/billing/bi001-service";
import { AdminReassignmentForm } from "@/components/billing/admin-reassignment-form";

export default async function AdminReassignmentCasePage({ params }: { params: { caseId: string } }) {
  const session = await requireAdminPermission("admin.billing.reassignment_case.read");
  if (!hasRecentAdminAuthentication(session)) {
    return <div><h1 className="text-2xl font-bold text-chakra-900">Recent authentication required</h1>
      <p className="mt-2 text-sm text-chakra-600">Sign in again before viewing this billing-assignment case.</p></div>;
  }
  const assignmentCase = getAdminReassignmentCase(params.caseId);
  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Subscription assignment case</h1>
      <p className="mt-2 text-sm text-chakra-500">Case {assignmentCase.caseId}. This screen exposes only the exact commercial assignment needed for review.</p>
      <AdminReassignmentForm assignmentCase={assignmentCase} />
    </div>
  );
}
