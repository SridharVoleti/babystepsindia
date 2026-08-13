import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { signOutAction } from "@/app/(auth)/actions";
import { listProducts } from "@/lib/db/products";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { getParentTimezone, listOwnedLearners } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";

export const metadata: Metadata = { title: "Your account — Baby Steps" };

export default async function AccountPage() {
  const { session } = await requireParentManagement();

  const productNames = new Map(listProducts().map((p) => [p.slug, p.name]));
  const subscribedProductNames = session.entitlements.products.map(
    (slug) => productNames.get(slug) ?? slug,
  );
  const learners = listOwnedLearners(
    session.sub,
    calendarDateInTimeZone(getParentTimezone(session.sub)),
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
            <Link href="/account/subscriptions"
              className="mt-3 inline-block text-sm font-medium text-green-700 hover:text-green-800">
              Manage subscriptions and assignment cases →
            </Link>
          </div>

          <div className="p-5">
            <Link href="/account/notifications"
              className="text-sm font-medium text-green-700 hover:text-green-800">
              Notification settings →
            </Link>
          </div>

          <div className="p-5">
            <Link
              href="/account/security"
              className="text-sm font-medium text-green-700 hover:text-green-800"
            >
              Account security →
            </Link>
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

        <section className="mt-8">
          <h2 className="text-lg font-semibold text-chakra-900">Learners</h2>
          <div className="card mt-3 divide-y divide-chakra-100">
            {learners.length === 0 ? (
              <p className="p-5 text-sm text-chakra-500">No learner profiles yet.</p>
            ) : learners.map((learner) => (
              <div key={learner.id} className="flex items-center justify-between gap-4 p-5">
                <div>
                  <p className="font-medium text-chakra-900">{learner.displayName}</p>
                  <p className="mt-1 text-xs text-chakra-400">Profile version {learner.version}</p>
                </div>
                <div className="flex gap-3">
                  <Link href={`/account/learners/${learner.id}/progress`}
                    className="text-sm font-medium text-green-700 hover:text-green-800">View progress</Link>
                  <Link href={`/account/learners/${learner.id}/edit`}
                    className="text-sm font-medium text-green-700 hover:text-green-800">Edit profile</Link>
                </div>
              </div>
            ))}
          </div>
        </section>

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
