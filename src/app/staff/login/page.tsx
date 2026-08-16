import type { Metadata } from "next";
import { StaffLoginForm } from "@/components/admin/staff-login-form";

export const metadata: Metadata = { title: "Staff sign in — Baby Steps" };

// AD-001 business rules 9-10: reachable only from the admin origin, never
// from a parent/learner route — a parent's bs_session never confers
// admin access, and this page never accepts one.
export default function StaffLoginPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">Staff sign in</h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Baby Steps administration. Separate from the parent/learner sign-in.
      </p>
      <StaffLoginForm />
      <p className="mt-6 text-center text-sm text-chakra-500">
        Lost every passkey? <a href="/staff/recovery" className="text-chakra-700 underline">Recover account access</a>
      </p>
    </div>
  );
}
