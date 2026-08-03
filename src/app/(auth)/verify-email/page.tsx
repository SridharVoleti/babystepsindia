import type { Metadata } from "next";
import { getSession } from "@/lib/auth/session";
import { ResendVerificationForm } from "@/components/auth/resend-verification-form";

export const metadata: Metadata = { title: "Verify your email — Baby Steps" };

export default async function VerifyEmailPage() {
  const session = await getSession();

  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
        Confirm your email
      </h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Check your inbox for a confirmation link. Didn&apos;t get it? Request a
        new one below.
      </p>
      <ResendVerificationForm defaultEmail={session?.email} />
    </>
  );
}
