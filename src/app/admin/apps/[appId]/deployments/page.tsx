import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getApp } from "@/lib/db/app-registry-repo";
import { DeploymentConsole } from "@/components/deployment-pipeline/deployment-console";

export async function generateMetadata({ params }: { params: { appId: string } }): Promise<Metadata> {
  const app = getApp(params.appId);
  return { title: app ? `${app.displayName} deployments — Baby Steps Admin` : "App not found — Baby Steps Admin" };
}

export default function AppDeploymentsPage({ params }: { params: { appId: string } }) {
  const app = getApp(params.appId);
  if (!app) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/admin/apps/${app.id}`} className="text-sm font-medium text-green-700 hover:text-green-800">
          ← Back to {app.displayName}
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">Deployments — {app.displayName}</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Bind a provider project, review CI-created releases, promote a staging-verified release to production.
          There is no field anywhere on this page for a production URL — the provider is always the source of truth.
        </p>
      </div>
      <DeploymentConsole appId={app.id} />
    </div>
  );
}
