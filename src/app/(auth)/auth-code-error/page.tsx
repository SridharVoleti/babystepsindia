import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Link expired — Baby Steps" };

export default function AuthCodeErrorPage() {
  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
        That link didn&apos;t work
      </h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        It may have expired or already been used. Request a new one below.
      </p>
      <div className="flex flex-col gap-3">
        <Link href="/login" className="btn-primary w-full">
          Back to log in
        </Link>
        <Link href="/reset-password" className="btn-secondary w-full">
          Request a new reset link
        </Link>
      </div>
    </>
  );
}
