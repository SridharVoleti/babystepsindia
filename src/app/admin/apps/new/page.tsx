import Link from "next/link";
import type { Metadata } from "next";
import { CreateAppForm } from "@/components/app-registry/create-app-form";

export const metadata: Metadata = { title: "Register app — Baby Steps Admin" };

export default function NewAppPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/apps" className="text-sm font-medium text-green-700 hover:text-green-800">
          ← Back to apps
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">Register app</h1>
      </div>

      <div className="card p-6">
        <CreateAppForm />
      </div>
    </div>
  );
}
