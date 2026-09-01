"use client";

import { useEffect, useState } from "react";
import { completeStaffReauth } from "@/lib/staff-identity/client-reauth";

type Binding = {
  id: string; environment: string; provider: string; providerTeamId: string; providerProjectId: string;
  expectedRepository: string; bindingStatus: "unverified" | "verified" | "disabled"; version: number;
};
type Release = {
  id: string; sourceCommitSha: string; artifactDigest: string; status: string;
  gateResults: Record<string, boolean>; createdAt: string;
};
type Publication = {
  environment: string; currentPublishedDeploymentId: string | null; previousHealthyDeploymentId: string | null;
  publishedAt: string | null;
};
type DeploymentWindow = {
  id: string; releaseId: string; startsAt: string; endsAt: string;
  status: "scheduled" | "draining" | "executing" | "completed" | "cancelled" | "failed" | "extended_safe_block";
  failureCode: string | null; version: number;
};

const ENVIRONMENTS = ["development", "staging", "production"] as const;

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export function DeploymentConsole({ appId }: { appId: string }) {
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [windows, setWindows] = useState<DeploymentWindow[]>([]);
  const [leadTimeMinutes, setLeadTimeMinutes] = useState(60);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const [bindingsRes, releasesRes, deploymentsRes, windowsRes] = await Promise.all([
      fetchJson<{ bindings: Binding[] }>(`/v1/admin/apps/${appId}/deployment-bindings`),
      fetchJson<{ releases: Release[] }>(`/v1/admin/apps/${appId}/releases`),
      fetchJson<{ publications: Publication[] }>(`/v1/admin/apps/${appId}/deployments`),
      fetchJson<{ windows: DeploymentWindow[]; leadTimeMinutes: number }>(`/v1/admin/apps/${appId}/deployment-windows`),
    ]);
    setBindings(bindingsRes?.bindings ?? []);
    setReleases(releasesRes?.releases ?? []);
    setPublications(deploymentsRes?.publications ?? []);
    setWindows(windowsRes?.windows ?? []);
    setLeadTimeMinutes(windowsRes?.leadTimeMinutes ?? 60);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  if (loading) return <p className="text-sm text-chakra-500">Loading…</p>;

  const productionPublication = publications.find((p) => p.environment === "production");
  const activeWindow = windows.find((w) => ["scheduled", "draining", "executing", "extended_safe_block"].includes(w.status));

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <h2 className="font-semibold text-chakra-900">Production status</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {ENVIRONMENTS.map((env) => {
            const publication = publications.find((p) => p.environment === env);
            return (
              <div key={env} className="rounded-lg border border-chakra-100 p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">{env}</p>
                <p className="mt-1 text-sm text-chakra-900">
                  {publication?.currentPublishedDeploymentId ? "Published" : "Not published"}
                </p>
                {publication?.publishedAt && (
                  <p className="text-xs text-chakra-500">{new Date(publication.publishedAt).toLocaleString()}</p>
                )}
              </div>
            );
          })}
        </div>
        {productionPublication?.currentPublishedDeploymentId && productionPublication?.previousHealthyDeploymentId && (
          <RollbackAction appId={appId} deploymentId={productionPublication.currentPublishedDeploymentId} onChanged={refresh} />
        )}
      </section>

      <BindingsSection appId={appId} bindings={bindings} onChanged={refresh} />
      <ReleasesSection appId={appId} releases={releases} bindings={bindings} activeWindow={activeWindow} leadTimeMinutes={leadTimeMinutes} onChanged={refresh} />
      <WindowsSection appId={appId} windows={windows} onChanged={refresh} />
    </div>
  );
}

function RollbackAction({ appId, deploymentId, onChanged }: { appId: string; deploymentId: string; onChanged: () => void }) {
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rollback(event: React.FormEvent) {
    event.preventDefault();
    if (!password) { setError("Current password is required to roll back."); return; }
    setBusy(true);
    setError(null);
    try {
      await completeStaffReauth(password);
    } catch {
      setBusy(false);
      setError("Reauthentication failed.");
      return;
    }

    // AD-004 rules 13, 43, 56-64: a manual rollback is a named high-impact
    // operation — it must reference a scoped operation change record before
    // AR-002's own rollback authority will accept it.
    const changeResponse = await fetch("/v1/admin/operations/changes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "manual_rollback", environment: "production", appId,
        reason: reason.length >= 20 ? reason : `Manual rollback of production deployment. Reason: ${reason || "not specified"}.`,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const changeBody = await changeResponse.json();
    if (!changeResponse.ok) {
      setBusy(false);
      setError(changeBody.error ?? "Could not open an operation change for this rollback.");
      return;
    }

    const response = await fetch(`/v1/admin/apps/${appId}/deployments/${deploymentId}/rollback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, idempotencyKey: crypto.randomUUID(), operationChangeId: changeBody.operationChangeId }),
    });
    const body = await response.json();
    setBusy(false);
    if (!response.ok) { setError(body.error ?? "Rollback failed."); return; }
    setPassword(""); setReason("");
    onChanged();
  }

  return (
    <form onSubmit={rollback} className="mt-4 flex flex-wrap items-end gap-2 border-t border-chakra-100 pt-4">
      <div>
        <label htmlFor="rollback-password" className="field-label">Current password</label>
        <input id="rollback-password" type="password" autoComplete="current-password" className="field-input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div>
        <label htmlFor="rollback-reason" className="field-label">Reason</label>
        <input id="rollback-reason" className="field-input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <button type="submit" disabled={busy} className="btn-secondary">
        {busy ? "Rolling back…" : "Roll back to previous healthy release"}
      </button>
      {error && <p role="alert" className="w-full rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">{error}</p>}
      <p className="w-full text-xs text-chakra-500">Existing learner sessions are unaffected — only new launches change.</p>
    </form>
  );
}

function BindingsSection({ appId, bindings, onChanged }: { appId: string; bindings: Binding[]; onChanged: () => void }) {
  const [environment, setEnvironment] = useState<string>("staging");
  const [providerTeamId, setProviderTeamId] = useState("");
  const [providerProjectId, setProviderProjectId] = useState("");
  const [expectedRepository, setExpectedRepository] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createBinding(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/v1/admin/apps/${appId}/deployment-bindings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        environment, provider: "vercel", providerTeamId, providerProjectId, expectedRepository,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const body = await response.json();
    setSubmitting(false);
    if (!response.ok) {
      setError(body.error ?? "Binding failed.");
      return;
    }
    setProviderTeamId(""); setProviderProjectId(""); setExpectedRepository("");
    onChanged();
  }

  async function verify(environmentToVerify: string) {
    setError(null);
    const response = await fetch(`/v1/admin/apps/${appId}/deployment-bindings/${environmentToVerify}/verify`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? "Verification failed.");
      return;
    }
    onChanged();
  }

  return (
    <section className="card p-5">
      <h2 className="font-semibold text-chakra-900">Provider project bindings</h2>
      <p className="mt-1 text-sm text-chakra-500">
        Select a provider-discovered project per environment. There is no field to type a live URL —
        the platform only ever trusts what the provider confirms after verification.
      </p>

      <ul className="mt-3 divide-y divide-chakra-100">
        {bindings.length === 0 && <li className="py-2 text-sm text-chakra-500">No bindings yet.</li>}
        {bindings.map((binding) => (
          <li key={binding.id} className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm font-medium text-chakra-900">{binding.environment}</p>
              <p className="text-xs text-chakra-500">
                {binding.provider}:{binding.providerProjectId} · {binding.bindingStatus}
              </p>
            </div>
            {binding.bindingStatus !== "verified" && (
              <button type="button" className="btn-secondary" onClick={() => verify(binding.environment)}>
                Verify
              </button>
            )}
          </li>
        ))}
      </ul>

      {error && <p role="alert" className="mt-3 rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">{error}</p>}

      <form onSubmit={createBinding} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="binding-environment" className="field-label">Environment</label>
          <select id="binding-environment" className="field-input" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            {ENVIRONMENTS.map((env) => <option key={env} value={env}>{env}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="binding-team" className="field-label">Provider team ID</label>
          <input id="binding-team" className="field-input" value={providerTeamId} onChange={(e) => setProviderTeamId(e.target.value)} />
        </div>
        <div>
          <label htmlFor="binding-project" className="field-label">Provider project ID</label>
          <input id="binding-project" className="field-input" value={providerProjectId} onChange={(e) => setProviderProjectId(e.target.value)} />
        </div>
        <div>
          <label htmlFor="binding-repo" className="field-label">Expected repository (owner/repo)</label>
          <input id="binding-repo" className="field-input" value={expectedRepository} onChange={(e) => setExpectedRepository(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <button type="submit" disabled={submitting || !providerTeamId || !providerProjectId || !expectedRepository} className="btn-primary">
            {submitting ? "Binding…" : "Bind project"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ReleasesSection({ appId, releases, bindings, activeWindow, leadTimeMinutes, onChanged }: {
  appId: string; releases: Release[]; bindings: Binding[]; activeWindow: DeploymentWindow | undefined; leadTimeMinutes: number; onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busyReleaseId, setBusyReleaseId] = useState<string | null>(null);

  const productionVerified = bindings.some((b) => b.environment === "production" && b.bindingStatus === "verified");

  async function deployStaging(releaseId: string) {
    setError(null);
    setBusyReleaseId(releaseId);
    const response = await fetch(`/v1/admin/apps/${appId}/releases/${releaseId}/deploy-staging`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
    });
    const body = await response.json().catch(() => ({}));
    setBusyReleaseId(null);
    if (!response.ok) { setError(body.detail ?? body.error ?? "Staging deploy failed."); return; }
    onChanged();
  }

  // AR-002 session 2, business rule 38: production promotion now requires a
  // pre-scheduled deployment window — there is no more direct "approve
  // production" action. Scheduling one at least 60 minutes ahead is what
  // makes a later promotion (automatic at the window's start, or a manual
  // approve-production call once the window is ready) possible at all.
  async function scheduleWindow(releaseId: string) {
    if (!password) { setError("Current password is required to schedule a deployment window."); return; }
    if (!startsAt || !endsAt) { setError("Both a start and end time are required."); return; }
    setError(null);
    setBusyReleaseId(releaseId);
    try {
      await completeStaffReauth(password);
    } catch {
      setBusyReleaseId(null);
      setError("Reauthentication failed.");
      return;
    }
    const response = await fetch(`/v1/admin/apps/${appId}/deployment-windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        releaseId, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(),
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const body = await response.json();
    setBusyReleaseId(null);
    if (!response.ok) { setError(body.error ?? "Scheduling failed."); return; }
    setPassword(""); setStartsAt(""); setEndsAt("");
    onChanged();
  }

  return (
    <section className="card p-5">
      <h2 className="font-semibold text-chakra-900">Releases</h2>
      <p className="mt-1 text-sm text-chakra-500">
        Releases are created only by an authenticated CI service from an approved commit — there is no
        button here to register a release by hand.
      </p>

      {error && <p role="alert" className="mt-3 rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">{error}</p>}

      <ul className="mt-3 divide-y divide-chakra-100">
        {releases.length === 0 && <li className="py-2 text-sm text-chakra-500">No releases yet.</li>}
        {releases.map((release) => (
          <li key={release.id} className="py-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-chakra-900">{release.sourceCommitSha}</p>
                <p className="text-xs text-chakra-500">{release.artifactDigest} · {release.status}</p>
              </div>
              <div className="flex items-center gap-2">
                {release.status === "created" && (
                  <button type="button" className="btn-secondary" disabled={busyReleaseId === release.id} onClick={() => deployStaging(release.id)}>
                    {busyReleaseId === release.id ? "Deploying…" : "Deploy to staging"}
                  </button>
                )}
                {release.status === "verified" && productionVerified && !activeWindow && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor={`window-starts-${release.id}`} className="field-label">Starts at (≥{leadTimeMinutes} min ahead)</label>
                      <input id={`window-starts-${release.id}`} type="datetime-local" className="field-input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor={`window-ends-${release.id}`} className="field-label">Ends at</label>
                      <input id={`window-ends-${release.id}`} type="datetime-local" className="field-input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                    </div>
                    <div>
                      <label htmlFor={`window-password-${release.id}`} className="field-label">Current password</label>
                      <input id={`window-password-${release.id}`} type="password" autoComplete="current-password" className="field-input" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    <button type="button" className="btn-primary" disabled={busyReleaseId === release.id} onClick={() => scheduleWindow(release.id)}>
                      {busyReleaseId === release.id ? "Scheduling…" : "Schedule production deployment"}
                    </button>
                  </div>
                )}
                {release.status === "verified" && activeWindow?.releaseId === release.id && (
                  <span className="text-xs font-medium text-chakra-600">Window {activeWindow.status} — new sessions blocked from drain start until publish or safe rollback completes.</span>
                )}
                {release.status === "promoted" && <span className="text-xs font-medium text-green-700">Live in production</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WindowsSection({ appId, windows, onChanged }: { appId: string; windows: DeploymentWindow[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busyWindowId, setBusyWindowId] = useState<string | null>(null);

  async function cancel(window: DeploymentWindow) {
    setError(null);
    setBusyWindowId(window.id);
    const response = await fetch(`/v1/admin/apps/${appId}/deployment-windows/${window.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: window.version, idempotencyKey: crypto.randomUUID() }),
    });
    const body = await response.json();
    setBusyWindowId(null);
    if (!response.ok) { setError(body.error ?? "Cancel failed."); return; }
    onChanged();
  }

  if (windows.length === 0) return null;

  return (
    <section className="card p-5">
      <h2 className="font-semibold text-chakra-900">Deployment windows</h2>
      <p className="mt-1 text-sm text-chakra-500">
        New session starts for this app are blocked from 60 minutes before a window's start until
        publication or safe rollback completes; other apps remain available. A blocked attempt uses no
        weekly slot, replacement credit, or launch code.
      </p>
      {error && <p role="alert" className="mt-3 rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">{error}</p>}
      <ul className="mt-3 divide-y divide-chakra-100">
        {windows.map((window) => (
          <li key={window.id} className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-chakra-900">
                {new Date(window.startsAt).toLocaleString()} – {new Date(window.endsAt).toLocaleString()}
              </p>
              <p className="text-xs text-chakra-500">
                {window.status}{window.failureCode ? ` · ${window.failureCode}` : ""}
              </p>
            </div>
            {(window.status === "scheduled" || window.status === "draining") && (
              <button type="button" className="btn-secondary" disabled={busyWindowId === window.id} onClick={() => cancel(window)}>
                {busyWindowId === window.id ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
