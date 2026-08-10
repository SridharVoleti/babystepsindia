import Link from "next/link";

// Development-only stand-in for an external provider-hosted page. It has no
// mutation capability: returning here or to Babysteps never marks payment as
// successful. Only the signed webhook/reconciliation paths can do that.
export default function LocalProviderHandoffPage({ params }: { params: { providerCheckoutRef: string } }) {
  return <main className="mx-auto max-w-xl px-6 py-16">
    <div className="card space-y-4 p-6">
      <h1 className="text-2xl font-bold text-chakra-900">Local payment-provider handoff</h1>
      <p className="text-sm text-chakra-600">Checkout reference: {params.providerCheckoutRef}</p>
      <p className="text-sm text-chakra-700">This development page cannot activate a subscription. Babysteps remains
        pending until a correctly signed provider event or billing reconciliation confirms payment.</p>
      <Link className="btn-secondary inline-block" href="/account/subscriptions">Return to subscriptions</Link>
    </div>
  </main>;
}
