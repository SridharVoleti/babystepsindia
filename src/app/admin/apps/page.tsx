import Link from "next/link";
import type { Metadata } from "next";
import { listApps } from "@/lib/db/app-registry-repo";
import { StatusPill } from "@/components/admin/status-pill";
import { BootstrapAppsButton } from "@/components/app-registry/bootstrap-apps-button";
import type { AppRegistryStatus } from "@/lib/db/types";

export const metadata: Metadata = { title: "Apps — Baby Steps Admin" };

const VALID_STATUSES: AppRegistryStatus[] = ["draft", "active", "soft_deleted"];

export default function AdminAppsPage({
  searchParams,
}: {
  searchParams: { search?: string; status?: string; includeSoftDeleted?: string };
}) {
  const includeSoftDeleted = searchParams.includeSoftDeleted === "true";
  const status = VALID_STATUSES.includes(searchParams.status as AppRegistryStatus)
    ? (searchParams.status as AppRegistryStatus)
    : undefined;

  const apps = listApps({
    search: searchParams.search || undefined,
    status,
    includeSoftDeleted,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-chakra-900">Apps</h1>
          <p className="mt-1 text-sm text-chakra-500">
            Canonical app registry (AR-001). Soft delete only — no app is
            ever hard-deleted.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <BootstrapAppsButton />
          <Link href="/admin/apps/new" className="btn-primary">
            Register app
          </Link>
        </div>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-4 p-5">
        <div>
          <label htmlFor="search" className="field-label">
            Search
          </label>
          <input
            id="search"
            name="search"
            defaultValue={searchParams.search ?? ""}
            placeholder="key or display name"
            className="field-input"
          />
        </div>
        <div>
          <label htmlFor="status" className="field-label">
            Status
          </label>
          <select id="status" name="status" defaultValue={searchParams.status ?? ""} className="field-input">
            <option value="">All (except soft-deleted)</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="soft_deleted">Soft-deleted</option>
          </select>
        </div>
        <label className="flex items-center gap-2 pb-2.5 text-sm text-chakra-700">
          <input type="checkbox" name="includeSoftDeleted" value="true" defaultChecked={includeSoftDeleted} />
          Include soft-deleted
        </label>
        <button type="submit" className="btn-secondary">
          Apply
        </button>
      </form>

      <div className="card divide-y divide-chakra-100">
        {apps.length === 0 ? (
          <p className="p-5 text-sm text-chakra-500">No apps match.</p>
        ) : (
          apps.map((app) => (
            <Link
              key={app.id}
              href={`/admin/apps/${app.id}`}
              className="flex items-center justify-between gap-4 p-5 hover:bg-chakra-50"
            >
              <div>
                <p className="font-medium text-chakra-900">{app.displayName}</p>
                <p className="mt-0.5 text-xs text-chakra-400">
                  {app.appKey} · v{app.version}
                </p>
              </div>
              <StatusPill status={app.registryStatus} />
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
