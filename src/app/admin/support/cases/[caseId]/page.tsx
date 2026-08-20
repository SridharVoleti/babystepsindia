import Link from "next/link";
import { requireAdminPermission } from "@/lib/auth/guards";
import { getSupportCase, listSupportCaseNotes } from "@/lib/support-cases/service";
import { composeCaseSnapshotSections } from "@/lib/support-cases/snapshot";
import { SupportCaseActions } from "@/components/admin/support-case-actions";
import { roleHasCapability } from "@/lib/staff-identity/roles";

const BILLING_CATEGORIES = new Set(["billing_question", "subscription_assignment", "payment_refund"]);

// AD-002 rules 90-93, 95: header shows case identity/status/category/
// assigned staff and safe parent context; sections not relevant/authorized
// are simply absent (never a blank/placeholder section). No sensitive data
// in the URL — only the case's own opaque id.
export default async function SupportCaseDetailPage({ params }: { params: { caseId: string } }) {
  const session = await requireAdminPermission("admin.support.case.read");
  const kase = await getSupportCase({ staffAccountId: session.staffAccountId, roleKeys: session.roleKeys }, params.caseId);
  const sections = await composeCaseSnapshotSections(params.caseId);
  const notes = await listSupportCaseNotes(params.caseId);

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Case {kase.id}</h1>
      <p className="mt-1 text-sm text-chakra-500">
        {kase.status} · {kase.category} · {kase.priority}
        {kase.escalation_role ? ` · escalated to ${kase.escalation_role}` : ""}
      </p>

      {BILLING_CATEGORIES.has(kase.category) && kase.subscription_id &&
        roleHasCapability(session.roleKeys, "admin.support.billing.workspace.read") && (
        <Link href={`/admin/support/cases/${kase.id}/billing?subscriptionId=${kase.subscription_id}`}
          className="btn-primary mt-4 inline-flex min-h-[44px] items-center px-4">
          Open billing workspace
        </Link>
      )}

      {sections && (
        <div className="mt-6 space-y-4">
          <section className="card p-4">
            <h2 className="font-semibold text-chakra-900">Parent</h2>
            <p className="mt-1 text-sm text-chakra-600">
              {sections.parent.displayName ?? "—"} · {sections.parent.maskedEmail} · {sections.parent.accountStatus}
            </p>
          </section>
          {sections.learner && (
            <section className="card p-4">
              <h2 className="font-semibold text-chakra-900">Learner</h2>
              <p className="mt-1 text-sm text-chakra-600">{sections.learner.displayName}{sections.learner.ageBand ? ` · ${sections.learner.ageBand}` : ""}</p>
              <ul className="mt-2 text-sm text-chakra-500">
                {sections.learner.apps.map((app) => <li key={app.appId}>{app.appName} — {app.entitlementState}</li>)}
              </ul>
            </section>
          )}
          {sections.progress && (
            <section className="card p-4">
              <h2 className="font-semibold text-chakra-900">Progress</h2>
              <p className="mt-1 text-sm text-chakra-600">
                {sections.progress.currentLevel ?? "Unavailable"} · integrity: {sections.progress.integrityState}
              </p>
            </section>
          )}
          {sections.billing && (
            <section className="card p-4">
              <h2 className="font-semibold text-chakra-900">Billing</h2>
              <p className="mt-1 text-sm text-chakra-600">
                {sections.billing.productName} · {sections.billing.billingCycleStatus}
                {sections.billing.gracePaymentStatus ? ` · ${sections.billing.gracePaymentStatus}` : ""}
                {sections.billing.cancellationStatus ? ` · ${sections.billing.cancellationStatus}` : ""}
              </p>
            </section>
          )}
          {sections.notifications && (
            <section className="card p-4">
              <h2 className="font-semibold text-chakra-900">Notification delivery</h2>
              <ul className="mt-1 text-sm text-chakra-600">
                {sections.notifications.map((n, i) => <li key={i}>{n.notificationType}: {n.deliveryState ?? n.state}</li>)}
              </ul>
            </section>
          )}
          {sections.technicalIssue && (
            <section className="card p-4">
              <h2 className="font-semibold text-chakra-900">Technical session</h2>
              <p className="mt-1 text-sm text-chakra-600">{sections.technicalIssue.status} · {sections.technicalIssue.lastUpdatedAt}</p>
            </section>
          )}
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold text-chakra-900">Notes</h2>
        {notes.length === 0 ? (
          <p className="mt-2 text-sm text-chakra-500">No notes yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {notes.map((note) => (
              <li key={note.noteId} className="card p-3 text-sm text-chakra-700">
                <p>{note.noteText}</p>
                <p className="mt-1 text-xs text-chakra-400">{note.createdAt}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SupportCaseActions caseId={kase.id} version={kase.version} status={kase.status} />
    </div>
  );
}
