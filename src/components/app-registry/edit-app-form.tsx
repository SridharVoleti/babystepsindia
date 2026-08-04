"use client";

import { useState } from "react";
import type { SafeAppRegistryView } from "@/lib/db/types";

export function EditAppForm({
  app,
  approvedIcons,
}: {
  app: SafeAppRegistryView;
  approvedIcons: Array<{ id: string; label: string }>;
}) {
  const [displayName, setDisplayName] = useState(app.displayName);
  const [shortDescription, setShortDescription] = useState(app.shortDescription ?? "");
  const [iconAssetKey, setIconAssetKey] = useState(app.iconAssetKey ?? "");
  const [category, setCategory] = useState(app.category ?? "");
  const [owningTeam, setOwningTeam] = useState(app.owningTeam ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/v1/admin/apps/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          shortDescription: shortDescription || null,
          iconAssetKey: iconAssetKey || null,
          category: category || null,
          owningTeam: owningTeam || null,
          expectedVersion: app.version,
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? body.error ?? "Couldn't save changes.");
        setSubmitting(false);
        return;
      }

      window.location.href = `/admin/apps/${app.id}`;
    } catch {
      setError("Couldn't save changes.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-5">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error === "APP_VERSION_CONFLICT"
            ? "This app was changed elsewhere — reload the page and try again."
            : error}
        </p>
      )}

      <div>
        <label className="field-label">App key</label>
        <input value={app.appKey} disabled className="field-input bg-chakra-50 text-chakra-500" />
        <p className="mt-1.5 text-xs text-chakra-400">Permanent — cannot be changed.</p>
      </div>

      <div>
        <label htmlFor="displayName" className="field-label">
          Display name
        </label>
        <input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="shortDescription" className="field-label">
          Short description {app.registryStatus === "draft" && "(required before activation)"}
        </label>
        <textarea
          id="shortDescription"
          rows={2}
          value={shortDescription}
          onChange={(e) => setShortDescription(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="iconAssetKey" className="field-label">
          Icon {app.registryStatus === "draft" && "(required before activation)"}
        </label>
        <select
          id="iconAssetKey"
          value={iconAssetKey}
          onChange={(e) => setIconAssetKey(e.target.value)}
          className="field-input"
        >
          <option value="">No icon selected</option>
          {approvedIcons.map((icon) => (
            <option key={icon.id} value={icon.id}>
              {icon.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="category" className="field-label">
          Category {app.registryStatus === "draft" && "(required before activation)"}
        </label>
        <input
          id="category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="owningTeam" className="field-label">
          Owning team {app.registryStatus === "draft" && "(required before activation)"}
        </label>
        <input
          id="owningTeam"
          value={owningTeam}
          onChange={(e) => setOwningTeam(e.target.value)}
          className="field-input"
        />
      </div>

      <button type="submit" disabled={submitting} className="btn-primary">
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
