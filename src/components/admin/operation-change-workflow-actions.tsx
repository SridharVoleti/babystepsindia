"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

// AD-004 rule 30: cancel is only offered before execution begins — once
// 'executing', ordinary cancel is refused by the service itself.
export function OperationChangeWorkflowActions({ operationChangeId, status, version }: {
  operationChangeId: string; status: string; version: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function setStatus(nextStatus: string) {
    setPending(true);
    setMessage(null);
    const response = await fetch(`/v1/admin/operations/changes/${operationChangeId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus, expectedVersion: version, idempotencyKey: crypto.randomUUID() }),
    });
    const payload = await response.json();
    setPending(false);
    if (response.ok) {
      router.refresh();
    } else {
      setMessage(`Rejected: ${payload.error}`);
    }
  }

  if (TERMINAL.has(status)) return null;

  return (
    <section className="card mt-6 p-4">
      <h2 className="font-semibold text-chakra-900">Workflow</h2>
      <div className="mt-2 flex flex-wrap gap-2">
        {status !== "executing" && (
          <button type="button" onClick={() => setStatus("cancelled")} disabled={pending}
            className="btn-secondary min-h-[44px] px-4">Cancel</button>
        )}
        <button type="button" onClick={() => setStatus("failed")} disabled={pending}
          className="btn-secondary min-h-[44px] px-4">Mark failed</button>
      </div>
      {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
    </section>
  );
}
