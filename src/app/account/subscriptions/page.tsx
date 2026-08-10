import Link from "next/link";
import { requireParentManagement } from "@/lib/auth/guards";
import { listParentSubscriptions } from "@/lib/billing/bi001-service";
import { getParentTimezone, listOwnedLearners } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { ReassignmentCaseForm } from "@/components/billing/reassignment-case-form";
import { AutoRenewControl } from "@/components/billing/auto-renew-control";
import { PaymentRecoveryPanel } from "@/components/billing/payment-recovery-panel";

export default async function ParentSubscriptionsPage() {
  const { session } = await requireParentManagement();
  const subscriptions = listParentSubscriptions(session.sub, { limit: 100 }).items;
  const learners = listOwnedLearners(session.sub,
    calendarDateInTimeZone(getParentTimezone(session.sub))).map((item) => ({ id: item.id, displayName: item.displayName }));
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link href="/account" className="text-sm text-green-700">← Account</Link>
      <h1 className="mt-4 text-2xl font-bold text-chakra-900">Subscriptions</h1>
      <div className="mt-6 space-y-4">
        {subscriptions.length ? subscriptions.map((subscription) => (
          <article id={subscription.id} key={subscription.id} className="card p-6">
            <div className="flex items-start justify-between gap-4">
              <div><h2 className="font-semibold text-chakra-900">{subscription.product.name}</h2>
                <p className="mt-1 text-sm text-chakra-700">For {subscription.assignedLearner.displayName}</p></div>
              <span className="rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">
                {subscription.status}</span>
            </div>
            <p className="mt-3 text-xs text-chakra-500">Assignment is not editable in self service.</p>
            <PaymentRecoveryPanel subscriptionId={subscription.id} paymentState={subscription.paymentState}
              graceEndsAt={subscription.graceEndsAt} expectedVersion={subscription.version} />
            {(subscription.status === "active" || subscription.status === "past_due") &&
              <AutoRenewControl subscriptionId={subscription.id}
              initialEnabled={subscription.autoRenewEnabled}
              initialCancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
              currentPeriodEnd={subscription.currentPeriodEnd}
              initialCancellationEffectiveAt={subscription.cancellationEffectiveAt}
              productName={subscription.product.name}
              learnerName={subscription.assignedLearner.displayName}
              expectedAmount={subscription.billingPrice?.amount ?? null}
              currency={subscription.billingPrice?.currency ?? null}
              expectedVersion={subscription.version} />}
          </article>
        )) : <p className="card p-6 text-sm text-chakra-600">No subscriptions yet.</p>}
      </div>
      <ReassignmentCaseForm subscriptions={subscriptions} learners={learners} />
    </main>
  );
}
