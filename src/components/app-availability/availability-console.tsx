"use client";

import { useEffect, useState } from "react";

type WindowView = { id: string; startsAt: string; endsAt: string; status: string;
  reasonCategory: string; learnerMessage: string | null; windowVersion: number };
type AvailabilityAdminView = { operationalAvailability: string; authoritativeState: string;
  availabilityVersion: number; safeStartUntil: string | null; expectedReturnAt: string | null;
  activeSessionOverlapCount: number; windows: WindowView[] };

export function AvailabilityConsole({ appId }: { appId: string }) {
  const [view, setView] = useState<AvailabilityAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const response = await fetch(`/v1/admin/apps/${appId}/availability?environment=production`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Availability could not be loaded."); return; }
    setView(body); setError(null);
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [appId]);

  async function schedule(event: React.FormEvent) {
    event.preventDefault();
    if (!view || !password || !startsAt || !endsAt) return;
    setBusy(true); setError(null);
    const response = await fetch(`/v1/admin/apps/${appId}/maintenance-windows`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environment: "production",
        startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
        reasonCategory: "planned_maintenance", learnerMessage: message || null,
        expectedAvailabilityVersion: view.availabilityVersion, idempotencyKey: crypto.randomUUID(),
        currentPassword: password }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setError(body.error ?? "Maintenance could not be scheduled."); return; }
    setPassword(""); setStartsAt(""); setEndsAt(""); setMessage(""); setView(body);
  }

  async function transition(targetState: "available" | "temporarily_unavailable" | "restoring") {
    if (!view || !password) { setError("Enter your current password first."); return; }
    setBusy(true); setError(null);
    const response = await fetch(`/v1/admin/apps/${appId}/availability-transition`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environment: "production",
        targetState, reasonCategory: targetState === "available" ? "service_confirmed" : "operations",
        learnerMessage: message || null, expectedAvailabilityVersion: view.availabilityVersion,
        idempotencyKey: crypto.randomUUID(), currentPassword: password }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setError(body.error ?? "Availability could not be changed."); return; }
    setPassword(""); setMessage(""); await refresh();
  }

  async function cancel(window: WindowView) {
    if (!view || !password) { setError("Enter your current password first."); return; }
    setBusy(true); setError(null);
    const response = await fetch(`/v1/admin/apps/${appId}/maintenance-windows/${window.id}`, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ environment: "production", action: "cancel",
        expectedAvailabilityVersion: view.availabilityVersion, expectedWindowVersion: window.windowVersion,
        idempotencyKey: crypto.randomUUID(), currentPassword: password }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setError(body.error ?? "Window could not be cancelled."); return; }
    setPassword(""); setView(body);
  }

  return <section className="card p-5">
    <h2 className="font-semibold text-chakra-900">Operational availability</h2>
    <p className="mt-1 text-sm text-chakra-500">Manual launch safety only. This does not change entitlement, credits, progress, or published deployment.</p>
    {error && <p role="alert" className="mt-3 rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">{error}</p>}
    {view && <>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <p className="rounded-lg border p-3 text-sm"><strong>State:</strong> {view.operationalAvailability}</p>
        <p className="rounded-lg border p-3 text-sm"><strong>Version:</strong> {view.availabilityVersion}</p>
        <p className="rounded-lg border p-3 text-sm"><strong>Current-session overlap:</strong> {view.activeSessionOverlapCount}</p>
      </div>
      {view.safeStartUntil && <p className="mt-2 text-sm text-chakra-600">Safe Start cutoff: {new Date(view.safeStartUntil).toLocaleString()}</p>}
      {view.activeSessionOverlapCount > 0 && <p className="mt-2 text-sm text-saffron-800">Warning: current sessions may overlap the planned window. They will not be rewritten or terminated.</p>}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="field-label" htmlFor="availability-password">Current password</label>
          <input id="availability-password" type="password" autoComplete="current-password" className="field-input"
            value={password} onChange={(event) => setPassword(event.target.value)} /></div>
        <div><label className="field-label" htmlFor="availability-message">Safe learner message (optional)</label>
          <input id="availability-message" maxLength={160} className="field-input" value={message}
            onChange={(event) => setMessage(event.target.value)} /></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => transition("temporarily_unavailable")}>Temporary launch block</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => transition("restoring")}>Restoring</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => transition("available")}>Return to available</button>
      </div>
      <form onSubmit={schedule} className="mt-5 border-t border-chakra-100 pt-4">
        <h3 className="text-sm font-semibold text-chakra-900">Schedule planned maintenance</h3>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="field-label" htmlFor="maintenance-start">Starts at</label><input id="maintenance-start" type="datetime-local" className="field-input" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></div>
          <div><label className="field-label" htmlFor="maintenance-end">Ends at</label><input id="maintenance-end" type="datetime-local" className="field-input" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></div>
        </div>
        <button type="submit" className="btn-secondary mt-3" disabled={busy || !startsAt || !endsAt || !password}>Schedule maintenance</button>
      </form>
      <ul className="mt-4 divide-y divide-chakra-100">
        {view.windows.map((window) => <li key={window.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p className="text-sm text-chakra-900">{new Date(window.startsAt).toLocaleString()} – {new Date(window.endsAt).toLocaleString()}</p><p className="text-xs text-chakra-500">{window.status} · v{window.windowVersion}</p></div>
          {window.status === "scheduled" && <button type="button" className="btn-secondary" disabled={busy} onClick={() => cancel(window)}>Cancel</button>}
        </li>)}
      </ul>
    </>}
  </section>;
}
