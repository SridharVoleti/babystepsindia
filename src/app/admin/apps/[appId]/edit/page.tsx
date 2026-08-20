import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getApp, listApprovedIcons } from "@/lib/db/app-registry-repo";
import { EditAppForm } from "@/components/app-registry/edit-app-form";

export const metadata: Metadata = { title: "Edit app — Baby Steps Admin" };

export default async function EditAppPage({ params }: { params: { appId: string } }) {
  const app = await getApp(params.appId);
  if (!app) notFound();

  const approvedIcons = await listApprovedIcons();

  return (
    <div className="space-y-6">
      <Link
        href={`/admin/apps/${app.id}`}
        className="text-sm font-medium text-green-700 hover:text-green-800"
      >
        ← Back to {app.displayName}
      </Link>
      <h1 className="text-2xl font-bold text-chakra-900">Edit {app.displayName}</h1>

      <div className="card p-6">
        <EditAppForm app={app} approvedIcons={approvedIcons} />
      </div>
    </div>
  );
}
