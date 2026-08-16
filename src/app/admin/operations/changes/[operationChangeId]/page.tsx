import { requireAdminPermission } from "@/lib/auth/guards";
import { getOperationChange, listOperationActivity } from "@/lib/operations-admin/service";
import { OperationChangeWorkflowActions } from "@/components/admin/operation-change-workflow-actions";

// AD-004 rules 25-30, 39: workflow status + append-only activity trail for
// one operation record. No generic action runner here — the change record
// itself never performs the underlying AR/UL/AU mutation.
export default async function OperationChangeDetailPage({ params }: { params: { operationChangeId: string } }) {
  const session = await requireAdminPermission("admin.operations.change.read");
  const change = getOperationChange(params.operationChangeId);
  const activity = listOperationActivity(params.operationChangeId);
  const canUpdate = session.roleKeys.includes("operations_administrator");

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Operation change {change.operationChangeId}</h1>
      <p className="mt-1 text-sm text-chakra-500">
        {change.changeType} · {change.status} · {change.environment}
        {change.appId ? ` · app ${change.appId}` : ""}
      </p>

      <section className="card mt-6 p-4">
        <h2 className="font-semibold text-chakra-900">Reason</h2>
        <p className="mt-1 text-sm text-chakra-600">{change.reason}</p>
      </section>

      {canUpdate && (
        <OperationChangeWorkflowActions
          operationChangeId={change.operationChangeId}
          status={change.status}
          version={change.version}
        />
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold text-chakra-900">Activity</h2>
        {activity.length === 0 ? (
          <p className="mt-2 text-sm text-chakra-500">No activity yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {activity.map((entry) => (
              <li key={entry.id} className="card p-3 text-sm text-chakra-700">
                <p>{entry.canonical_action} — {entry.result}{entry.resource_safe_id ? ` (${entry.resource_safe_id})` : ""}</p>
                <p className="mt-1 text-xs text-chakra-400">{entry.created_at}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
