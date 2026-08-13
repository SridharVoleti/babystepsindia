import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { DeleteAccountForm } from "@/components/account/delete-account-form";

export const metadata: Metadata = { title: "Delete account — Baby Steps" };

export default async function DeleteAccountPage() {
  await requireParentManagement();

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <Link
        href="/account/security"
        className="text-sm font-medium text-green-700 hover:text-green-800"
      >
        ← Back to account security
      </Link>
      <h1 className="mt-3 mb-6 text-2xl font-bold text-chakra-900">Delete account</h1>

      <div className="card p-6">
        <DeleteAccountForm />
      </div>
    </main>
  );
}
