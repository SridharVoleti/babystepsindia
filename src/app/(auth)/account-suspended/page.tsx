import Link from "next/link";
import type { Metadata } from "next";
import { signOutAction } from "@/app/(auth)/actions";

export const metadata: Metadata = { title: "Account suspended — Baby Steps" };

export default function AccountSuspendedPage() {
  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
        This account is unavailable
      </h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Your account can&apos;t access Baby Steps right now. Contact support if
        you think this is a mistake.
      </p>
      <div className="flex flex-col gap-3">
        <Link href="mailto:support@babysteps.in" className="btn-primary w-full text-center">
          Contact support
        </Link>
        <form action={signOutAction}>
          <button type="submit" className="btn-secondary w-full">
            Log out
          </button>
        </form>
      </div>
    </>
  );
}
