"use client";

import { useState } from "react";
import type { ConsistencyCurrentView, ConsistencyHistoryView } from "@/lib/consistency/service";

const STATUS_COPY: Record<ConsistencyHistoryView["status"], string> = {
  cadence_complete: "Normal weekly cadence completed",
  incomplete_reset: "Weekly cadence was not completed; a new streak can begin this week",
  neutral_partial: "Partial access week — streak unchanged",
  platform_unavailable_neutral: "Platform availability made this a neutral week",
  out_of_scope: "App access was not active for this week",
};

export function ConsistencyHistory({ apps, initialHistory, initialCursor, endpoint }: {
  apps: ConsistencyCurrentView[]; initialHistory: ConsistencyHistoryView[]; initialCursor: string | null;
  endpoint: string;
}) {
  const [history, setHistory] = useState(initialHistory);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true); setError(null);
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await fetch(`${endpoint}${separator}cursor=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("load failed");
      const page = await response.json() as { history: ConsistencyHistoryView[]; nextCursor: string | null };
      setHistory((current) => [...current, ...page.history]); setCursor(page.nextCursor);
    } catch { setError("Could not load more weekly history."); }
    finally { setLoading(false); }
  }

  return <div className="mt-6 space-y-8">
    <section aria-labelledby="current-consistency-title">
      <h2 id="current-consistency-title" className="text-xl font-semibold text-chakra-900">This week by app</h2>
      <p className="mt-1 text-sm text-chakra-600">Each streak means completing that app&apos;s normal two weekly sessions.</p>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {apps.map((app) => <article key={app.appId} className="card p-5">
          <h3 className="font-semibold text-chakra-900">{app.appName}</h3>
          <p className="mt-2 text-lg font-medium text-green-700">{app.currentWeekProgress} of 2 this week</p>
          <p className="mt-1 text-sm text-chakra-600">Current streak: {app.currentStreakWeeks} weeks</p>
          <p className="text-sm text-chakra-500">Longest streak: {app.longestStreakWeeks} weeks</p>
        </article>)}
        {apps.length === 0 && <p className="text-sm text-chakra-500">No app consistency is available yet.</p>}
      </div>
    </section>
    <section aria-labelledby="consistency-history-title">
      <h2 id="consistency-history-title" className="text-xl font-semibold text-chakra-900">Weekly history</h2>
      <div className="mt-4 space-y-3">
        {history.map((week) => <article key={`${week.appId}:${week.weeklyKey}`}
          className="rounded-xl border border-chakra-100 bg-white p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="font-semibold text-chakra-900">{week.appName}</h3>
            <span className="text-sm text-chakra-500">{week.weeklyKey}</span>
          </div>
          <p className="mt-2 text-sm text-chakra-700">{week.qualifyingStandardSessions} of 2 sessions</p>
          <p className="mt-1 text-sm text-chakra-500">{STATUS_COPY[week.status]}</p>
        </article>)}
        {history.length === 0 && <p className="text-sm text-chakra-500">No finalized weekly history yet.</p>}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      {cursor && <button type="button" className="btn-secondary mt-4 min-h-[44px]" disabled={loading} onClick={loadMore}>
        {loading ? "Loading…" : "Load more"}
      </button>}
    </section>
  </div>;
}
