import Link from "next/link";
import type { Metadata } from "next";
import { UpdatePasswordForm } from "@/components/auth/update-password-form";

export const metadata: Metadata = { title: "Set new password — Baby Steps" };

export default function UpdatePasswordPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token;

  if (!token) {
    return (
      <>
        <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
          Missing reset link
        </h1>
        <p className="mb-6 text-center text-sm text-chakra-500">
          Open this page from the link in your password reset request.
        </p>
        <Link href="/reset-password" className="btn-primary w-full">
          Request a reset link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-center text-2xl font-bold text-chakra-900">
        Set a new password
      </h1>
      <UpdatePasswordForm token={token} />
    </>
  );
}
