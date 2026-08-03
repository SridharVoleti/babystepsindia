import type { Metadata } from "next";
import { RestoreForm } from "@/components/admin/restore-form";

export const metadata: Metadata = { title: "Restore account — Baby Steps Admin" };

export default function AdminRestorePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Restore account</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Reactivates a soft-deleted parent account (IA-003). Sessions are not
          restored — the parent must log in again. No self-service restore
          exists; this is the only path back for a deleted account.
        </p>
      </div>

      <div className="card p-6">
        <RestoreForm />
      </div>
    </div>
  );
}
