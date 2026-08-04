import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getApp } from "@/lib/db/app-registry-repo";
import { StatusPill } from "@/components/admin/status-pill";
import { ActivateAppForm } from "@/components/app-registry/activate-app-form";
import { SoftDeleteAppForm } from "@/components/app-registry/soft-delete-app-form";
import { RestoreAppForm } from "@/components/app-registry/restore-app-form";

export async function generateMetadata({ params }: { params: { appId: string } }): Promise<Metadata> {
  const app = getApp(params.appId);
  return { title: app ? `${app.displayName} — Baby Steps Admin` : "App not found — Baby Steps Admin" };
}

export default function AppDetailPage({ params }: { params: { appId: string } }) {
  const app = getApp(params.appId);
  if (!app) notFound();

  const readyForActivation = Boolean(app.shortDescription && app.iconAssetKey && app.category && app.owningTeam);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/admin/apps" className="text-sm font-medium text-green-700 hover:text-green-800">
            ← Back to apps
          </Link>
          <h1 className="mt-3 text-2xl font-bold text-chakra-900">{app.displayName}</h1>
        </div>
        <StatusPill status={app.registryStatus} />
      </div>

      <div className="card divide-y divide-chakra-100">
        <Row label="App key (permanent)" value={app.appKey} />
        <Row label="Short description" value={app.shortDescription ?? "—"} />
        <Row label="Icon" value={app.iconAssetKey ?? "—"} />
        <Row label="Category" value={app.category ?? "—"} />
        <Row label="Owning team" value={app.owningTeam ?? "—"} />
        <Row label="Version" value={String(app.version)} />
        <Row label="Created" value={new Date(app.createdAt).toLocaleString()} />
        {app.activatedAt && <Row label="Activated" value={new Date(app.activatedAt).toLocaleString()} />}
        {app.softDeletedAt && (
          <Row
            label="Soft-deleted"
            value={`${new Date(app.softDeletedAt).toLocaleString()} (${app.softDeleteReasonCode})`}
          />
        )}
      </div>

      {app.registryStatus !== "soft_deleted" && (
        <div className="card p-5">
          <Link href={`/admin/apps/${app.id}/edit`} className="btn-secondary">
            Edit metadata
          </Link>
        </div>
      )}

      {app.registryStatus === "draft" && (
        <div className="card p-5">
          <h2 className="font-semibold text-chakra-900">Activate</h2>
          <p className="mt-1 text-sm text-chakra-500">
            {readyForActivation
              ? "Metadata is complete — this app can be activated."
              : "Short description, icon, category, and owning team must all be set before activation."}
          </p>
          <div className="mt-3">
            <ActivateAppForm appId={app.id} expectedVersion={app.version} />
          </div>
        </div>
      )}

      {(app.registryStatus === "draft" || app.registryStatus === "active") && (
        <div className="card p-5">
          <h2 className="font-semibold text-saffron-800">Soft delete</h2>
          <p className="mt-1 text-sm text-chakra-500">
            Stops this app from being used immediately. Nothing is erased —
            learner progress, billing history, and this app&apos;s own
            identity (id and key) are all retained. Existing subscriptions
            are not automatically cancelled or refunded.
          </p>
          <div className="mt-3">
            <SoftDeleteAppForm appId={app.id} appKey={app.appKey} expectedVersion={app.version} />
          </div>
        </div>
      )}

      {app.registryStatus === "soft_deleted" && (
        <div className="card p-5">
          <h2 className="font-semibold text-chakra-900">Restore</h2>
          <RestoreAppForm appId={app.id} expectedVersion={app.version} />
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">{label}</p>
      <p className="mt-1 text-chakra-900">{value}</p>
    </div>
  );
}
