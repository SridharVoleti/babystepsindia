"use client";

import { useEffect, useState } from "react";

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
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    const [bindingsRes, releasesRes, deploymentsRes] = await Promise.all([
      fetchJson<{ bindings: Binding[] }>(`/v1/admin/apps/${appId}/deployment-bindings`),
      fetchJson<{ releases: Release[] }>(`/v1/admin/apps/${appId}/releases`),
      fetchJson<{ publications: Publication[] }>(`/v1/admin/apps/${appId}/deployments`),
    ]);
    setBindings(bindingsRes?.bindings ?? []);
    setReleases(releasesRes?.releases ?? []);
    setPublications(deploymentsRes?.publications ?? []);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  if (loading) return <p className="text-sm text-chakra-500">Loading…</p>;

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
      </section>

      <BindingsSection appId={appId} bindings={bindings} onChanged={refresh} />
      <ReleasesSection appId={appId} releases={releases} bindings={bindings} onChanged={refresh} />
    </div>
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

function ReleasesSection({ appId, releases, bindings, onChanged }: {
  appId: string; releases: Release[]; bindings: Binding[]; onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
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
    const body = await response.json();
    setBusyReleaseId(null);
    if (!response.ok) { setError(body.error ?? "Staging deploy failed."); return; }
    onChanged();
  }

  async function approveProduction(releaseId: string) {
    if (!password) { setError("Current password is required to approve production."); return; }
    setError(null);
    setBusyReleaseId(releaseId);
    const response = await fetch(`/v1/admin/apps/${appId}/releases/${releaseId}/approve-production`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: password, idempotencyKey: crypto.randomUUID() }),
    });
    const body = await response.json();
    setBusyReleaseId(null);
    if (!response.ok) { setError(body.error ?? "Production approval failed."); return; }
    setPassword("");
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
                {release.status === "verified" && productionVerified && (
                  <div className="flex items-end gap-2">
                    <div>
                      <label htmlFor={`prod-password-${release.id}`} className="field-label">Current password</label>
                      <input
                        id={`prod-password-${release.id}`} type="password" autoComplete="current-password"
                        className="field-input" value={password} onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                    <button type="button" className="btn-primary" disabled={busyReleaseId === release.id} onClick={() => approveProduction(release.id)}>
                      {busyReleaseId === release.id ? "Approving…" : "Approve production"}
                    </button>
                  </div>
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
