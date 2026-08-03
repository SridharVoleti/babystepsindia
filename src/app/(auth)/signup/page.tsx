import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = { title: "Sign up — Baby Steps" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-6 text-center text-2xl font-bold text-chakra-900">
        Create your account
      </h1>
      <SignupForm />
    </>
  );
}
