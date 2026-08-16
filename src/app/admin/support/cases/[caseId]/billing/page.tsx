import { requireAdminPermission } from "@/lib/auth/guards";
import { composeBillingWorkspace, getReassignmentEligibility, getRefundEligibility } from "@/lib/support-cases/billing";
import { SupportBillingActions } from "@/components/admin/support-billing-actions";

// AD-003 rules 18, 89-90: the billing workspace lives at
// /admin/support/cases/{caseId}/billing, grouping only the sections
// relevant to this case's category.
export default async function SupportCaseBillingPage({ params, searchParams }: {
  params: { caseId: string }; searchParams: { subscriptionId?: string };
}) {
  const session = await requireAdminPermission("admin.support.billing.workspace.read");
  const actor = { staffAccountId: session.staffAccountId, roleKeys: session.roleKeys };
  const workspace = composeBillingWorkspace(actor, params.caseId, searchParams.subscriptionId);
  const reassignmentEligibility = getReassignmentEligibility(actor, params.caseId, workspace.subscription.id);
  const refundEligibility = getRefundEligibility(actor, params.caseId, workspace.subscription.id);

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Billing workspace</h1>
      <p className="mt-1 text-sm text-chakra-500">Case {workspace.caseHeader.caseId} · {workspace.caseHeader.category}</p>

      <section className="card mt-6 p-4">
        <h2 className="font-semibold text-chakra-900">Subscription</h2>
        <p className="mt-1 text-sm text-chakra-600">
          {workspace.subscription.productName} · {workspace.subscription.paymentState}
          {workspace.subscription.graceEndsAt ? ` · grace until ${workspace.subscription.graceEndsAt}` : ""}
          {workspace.subscription.cancelAtPeriodEnd ? " · cancel at period end" : ""}
        </p>
        <p className="mt-1 text-xs text-chakra-500">
          Current period: {workspace.subscription.currentPeriodStart} → {workspace.subscription.currentPeriodEnd}
        </p>
      </section>

      {workspace.entitlementImpact.length > 0 && (
        <section className="card mt-4 p-4">
          <h2 className="font-semibold text-chakra-900">Entitlement impact</h2>
          <ul className="mt-1 text-sm text-chakra-600">
            {workspace.entitlementImpact.map((e, i) => <li key={i}>{e.app_id}: {e.state}</li>)}
          </ul>
        </section>
      )}

      {workspace.documents.length > 0 && (
        <section className="card mt-4 p-4">
          <h2 className="font-semibold text-chakra-900">Financial documents</h2>
          <ul className="mt-1 text-sm text-chakra-600">
            {workspace.documents.map((d) => <li key={d.refundCaseId}>{d.refundType} · {d.status} · {d.amount ?? "full"}</li>)}
          </ul>
        </section>
      )}

      <SupportBillingActions
        caseId={params.caseId} subscriptionId={workspace.subscription.id}
        currentLearnerId={workspace.subscription.assignedLearnerId} subscriptionVersion={workspace.subscription.version}
        eligibleTargets={reassignmentEligibility.eligibleTargets}
        maxRefundableAmount={refundEligibility.maxRefundableAmount} currency={refundEligibility.currency}
      />
    </div>
  );
}
