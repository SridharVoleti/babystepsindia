"use client";

import { useState } from "react";
import type { JourneyEventView, JourneyOrder, JourneyRetentionView } from "@/lib/journey/service";

type JourneyPage = {
  events: JourneyEventView[];
  nextCursor: string | null;
  order: JourneyOrder;
  retentionState: JourneyRetentionView;
};

const EVENT_LABELS: Record<JourneyEventView["eventType"], string> = {
  lesson_completed: "Lesson completed",
  achievement_earned: "Achievement earned",
  milestone_reached: "Milestone reached",
};

function displayDate(date: string) {
  return new Date(`${date}T00:00:00+05:30`).toLocaleDateString(undefined,
    { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}

export function JourneyTimeline({ initialPage, endpoint }: { initialPage: JourneyPage; endpoint: string }) {
  const [events, setEvents] = useState(initialPage.events);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [order, setOrder] = useState<JourneyOrder>(initialPage.order);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextOrder: JourneyOrder, cursor?: string | null) {
    setBusy(true); setError(null);
    try {
      const query = new URLSearchParams({ order: nextOrder, limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${endpoint}?${query}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("JOURNEY_READ_FAILED");
      const page = await response.json() as JourneyPage;
      setOrder(nextOrder);
      setEvents((current) => cursor ? [...current, ...page.events.filter((event) =>
        !current.some((existing) => existing.journeyEventId === event.journeyEventId))] : page.events);
      setNextCursor(page.nextCursor);
    } catch { setError("Journey could not be loaded right now."); }
    finally { setBusy(false); }
  }

  return <section className="mt-6" aria-labelledby="journey-events-title">
    {initialPage.retentionState.state === "inactive_retention" && initialPage.retentionState.retainedUntilDate &&
      <p className="rounded-lg border border-chakra-200 bg-chakra-50 p-4 text-sm text-chakra-700" role="status">
        Journey retained until {displayDate(initialPage.retentionState.retainedUntilDate)}.
      </p>}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <h2 id="journey-events-title" className="text-lg font-semibold text-chakra-900">Journey events</h2>
      <div className="inline-flex rounded-lg border border-chakra-200 p-1" role="group" aria-label="Journey order">
        <button type="button" className={`min-h-[44px] rounded-md px-4 text-sm ${order === "desc" ? "bg-green-700 text-white" : "text-chakra-700"}`}
          aria-pressed={order === "desc"} disabled={busy} onClick={() => void load("desc")}>Newest first</button>
        <button type="button" className={`min-h-[44px] rounded-md px-4 text-sm ${order === "asc" ? "bg-green-700 text-white" : "text-chakra-700"}`}
          aria-pressed={order === "asc"} disabled={busy} onClick={() => void load("asc")}>Oldest first</button>
      </div>
    </div>
    {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
    {events.length === 0 ? <div className="card mt-4 p-6">
      <p className="font-medium text-chakra-900">No journey events yet</p>
      <p className="mt-1 text-sm text-chakra-600">Completed lessons and meaningful milestones will appear here.</p>
    </div> : <ol className="mt-5 space-y-4 md:border-l-2 md:border-chakra-200 md:pl-6">
      {events.map((event) => <li key={event.journeyEventId} className="card relative p-5 md:before:absolute md:before:-left-[31px] md:before:top-6 md:before:h-3 md:before:w-3 md:before:rounded-full md:before:bg-green-700">
        <p className="text-sm font-semibold text-green-700">{displayDate(event.displayDate)}</p>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-chakra-500">{EVENT_LABELS[event.eventType]}</p>
        <h3 className="mt-1 text-lg font-semibold text-chakra-900">{event.title}</h3>
        {event.shortDescription && <p className="mt-2 text-sm text-chakra-700">{event.shortDescription}</p>}
      </li>)}
    </ol>}
    {nextCursor && <button type="button" className="btn-secondary mt-5 min-h-[44px] min-w-[44px]" disabled={busy}
      onClick={() => void load(order, nextCursor)}>{busy ? "Loading…" : "Load more"}</button>}
  </section>;
}

