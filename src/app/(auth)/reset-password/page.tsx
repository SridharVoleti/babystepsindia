import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Reset password — Baby Steps" };

export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">
        Reset your password
      </h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Enter the email on your account and we&apos;ll send a reset link.
      </p>
      <ResetPasswordForm />
    </>
  );
}
