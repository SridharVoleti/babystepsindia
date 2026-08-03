import Link from "next/link";
import { signOutAction } from "@/app/(auth)/actions";

export function AdminNav() {
  return (
    <header className="border-b border-chakra-100 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/admin" className="text-lg font-bold text-chakra-900">
            Baby Steps Admin
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium text-chakra-600">
            <Link href="/admin" className="hover:text-chakra-900">
              Overview
            </Link>
            <Link href="/admin/grant" className="hover:text-chakra-900">
              Grant access
            </Link>
            <Link href="/admin/audit" className="hover:text-chakra-900">
              Audit log
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <Link href="/account" className="text-chakra-500 hover:text-chakra-800">
            Back to site
          </Link>
          <form action={signOutAction}>
            <button type="submit" className="btn-secondary py-1.5 text-xs">
              Log out
            </button>
          </form>
        </div>
      </div>
      <div className="tricolor-rule" />
    </header>
  );
}
