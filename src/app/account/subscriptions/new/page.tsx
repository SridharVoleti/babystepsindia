import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { findProductBySlug } from "@/lib/db/products";
import { getParentTimezone, listOwnedLearners } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { getProductPurchaseView } from "@/lib/billing/bi001-service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { CheckoutAssignmentForm } from "@/components/billing/checkout-assignment-form";

export default async function NewSubscriptionPage({ searchParams }: { searchParams: { product?: string; learner?: string } }) {
  const { session } = await requireParentManagement();
  const product = searchParams.product ? await findProductBySlug(searchParams.product) : undefined;
  if (!product) notFound();
  let purchaseView;
  try { purchaseView = getProductPurchaseView(product.id); } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return <main className="mx-auto max-w-2xl px-6 py-16"><h1 className="text-2xl font-bold">Product unavailable</h1>
        <p className="mt-3 text-chakra-600">This product is not ready for checkout.</p></main>;
    }
    throw error;
  }
  const learners = (await listOwnedLearners(session.sub,
    calendarDateInTimeZone(await getParentTimezone(session.sub)))).map((item) => ({ id: item.id, displayName: item.displayName }));
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/#products" className="text-sm text-green-700">← Products</Link>
      <h1 className="mt-4 text-2xl font-bold text-chakra-900">Review your subscription</h1>
      <p className="mt-2 text-sm text-chakra-600">Choose the one learner, review the exact charge and decide whether it should renew automatically.</p>
      {learners.length ? <div className="mt-6"><CheckoutAssignmentForm product={purchaseView} learners={learners}
        initialLearnerId={searchParams.learner} /></div> :
        <p className="card mt-6 p-6 text-sm text-chakra-600">Create a learner profile before starting checkout.</p>}
    </main>
  );
}
