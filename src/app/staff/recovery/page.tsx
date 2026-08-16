import type { Metadata } from "next";
import { StaffRecoveryEnrollmentForm } from "@/components/admin/staff-recovery-enrollment-form";

export const metadata: Metadata = { title: "Staff account recovery — Baby Steps" };

// AD-005 rules 39-46, 50, 59-60: pre-MFA, outside the /admin layout (no
// requireAdmin() gate — a locked-out staff member has no session), same
// reachability pattern as /staff/login. Never itself an admin session —
// only a single new passkey enrollment, then a normal password+passkey
// login at /staff/login.
export default function StaffRecoveryPage() {
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="mb-2 text-center text-2xl font-bold text-chakra-900">Staff account recovery</h1>
      <p className="mb-6 text-center text-sm text-chakra-500">
        Only for a staff member who has lost every registered passkey. This registers one new passkey — it does
        not sign you in by itself.
      </p>
      <StaffRecoveryEnrollmentForm />
    </div>
  );
}
