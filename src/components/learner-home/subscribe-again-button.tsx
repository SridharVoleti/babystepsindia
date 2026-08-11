"use client";

import { useState } from "react";

export function SubscribeAgainButton({ learnerId, appId }: { learnerId: string; appId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribeAgain() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/v1/parent/learners/${learnerId}/past-apps/${appId}/subscribe-again`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !payload.eligible) {
        setError("This app can't be subscribed to again right now.");
        return;
      }
      window.location.assign(`/account/subscriptions/new?product=${encodeURIComponent(payload.productSlug)}&learner=${encodeURIComponent(learnerId)}`);
    } finally { setPending(false); }
  }

  return (
    <div>
      <button type="button" className="btn-secondary min-h-[44px]" onClick={subscribeAgain} disabled={pending}>
        {pending ? "Checking…" : "Subscribe again"}
      </button>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
