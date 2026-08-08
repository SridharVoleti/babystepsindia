import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { getSecurityView } from "@/lib/db/account-security-repo";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { AccountSecurityView } from "@/components/account/account-security-view";

export const metadata: Metadata = { title: "Account security — Baby Steps" };

export default async function AccountSecurityPage() {
  const { session } = await requireParentManagement();
  const view = getSecurityView(session.sub, session.email);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <Link href="/account" className="text-sm font-medium text-green-700 hover:text-green-800">
          ← Back to account
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">Account security</h1>

        <div className="mt-6">
          <AccountSecurityView initialView={view} />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
