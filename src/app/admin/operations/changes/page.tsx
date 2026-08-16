import Link from "next/link";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listOperationChanges } from "@/lib/operations-admin/service";
import { OperationChangeCreateForm } from "@/components/admin/operation-change-create-form";

// AD-004 rules 17-25, 32-33: a queue of scoped operation/change records —
// the one place a human-visible operational action is proposed before any
// AR-001/AR-002/UL-004 mutation may reference it.
export default async function OperationChangesPage() {
  const session = await requireAdminPermission("admin.operations.change.list");
  const result = listOperationChanges(
    { staffAccountId: session.staffAccountId, roleKeys: session.roleKeys }, {},
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Operation changes</h1>
      <p className="mt-1 text-sm text-chakra-500">
        Every high-impact platform operation (app registry, release, rollback, maintenance) is recorded here first.
      </p>

      <div className="mt-6"><OperationChangeCreateForm /></div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-chakra-900">Recent changes</h2>
        {result.changes.length === 0 ? (
          <p className="mt-3 text-sm text-chakra-500">No operation changes yet.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {result.changes.map((c) => (
              <Link key={c.operationChangeId} href={`/admin/operations/changes/${c.operationChangeId}`}
                className="card block p-4 hover:border-green-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-chakra-900">{c.changeType}</span>
                  <span className="text-sm text-chakra-500">{c.status} · {c.environment}</span>
                </div>
                <p className="mt-1 text-xs text-chakra-400">Updated {c.updatedAt}</p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
