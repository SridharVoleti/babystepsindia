import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Log in — Baby Steps" };

export default function LoginPage() {
  return (
    <>
      <h1 className="mb-6 text-center text-2xl font-bold text-chakra-900">
        Log in
      </h1>
      <LoginForm />
    </>
  );
}
