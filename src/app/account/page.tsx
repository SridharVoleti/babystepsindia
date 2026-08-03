import Link from "next/link";
import type { Metadata } from "next";
import { requireSession } from "@/lib/auth/guards";
import { signOutAction } from "@/app/(auth)/actions";
import { listProducts } from "@/lib/db/products";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = { title: "Your account — Baby Steps" };

export default async function AccountPage() {
  const session = await requireSession();

  const productNames = new Map(listProducts().map((p) => [p.slug, p.name]));
  const subscribedProductNames = session.entitlements.products.map(
    (slug) => productNames.get(slug) ?? slug,
  );

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <h1 className="text-2xl font-bold text-chakra-900">Your account</h1>

        <div className="card mt-6 divide-y divide-chakra-100">
          <div className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">
              Email
            </p>
            <p className="mt-1 text-chakra-900">{session.email}</p>
          </div>

          <div className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">
              Subscriptions
            </p>
            <p className="mt-1 text-chakra-900">
              {session.entitlements.bundle
                ? "Full bundle"
                : subscribedProductNames.join(", ") || "No active subscriptions"}
            </p>
            <p className="mt-1 text-xs text-chakra-400">
              Reflects your session at login — log out and back in after an
              admin grants access to see a change (REQ-08 §4.2).
            </p>
          </div>

          {session.isAdmin && (
            <div className="p-5">
              <Link
                href="/admin"
                className="text-sm font-medium text-green-700 hover:text-green-800"
              >
                Go to admin dashboard →
              </Link>
            </div>
          )}
        </div>

        <form action={signOutAction} className="mt-6">
          <button type="submit" className="btn-secondary">
            Log out
          </button>
        </form>
      </main>
      <SiteFooter />
    </div>
  );
}
