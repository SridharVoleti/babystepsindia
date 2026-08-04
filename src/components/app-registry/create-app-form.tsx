"use client";

import { useState } from "react";

const APP_KEY_PATTERN = /^[a-z][a-z0-9-]{1,49}$/;

export function CreateAppForm() {
  const [appKey, setAppKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyValid = APP_KEY_PATTERN.test(appKey);
  const canSubmit = keyValid && displayName.trim().length > 0 && !submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/admin/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey, displayName, idempotencyKey: crypto.randomUUID() }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? body.error ?? "Couldn't create the app.");
        setSubmitting(false);
        return;
      }

      window.location.href = `/admin/apps/${body.id}`;
    } catch {
      setError("Couldn't create the app.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-5">
      {error && (
        <p role="alert" className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="appKey" className="field-label">
          App key (permanent — cannot be changed later)
        </label>
        <input
          id="appKey"
          value={appKey}
          onChange={(e) => setAppKey(e.target.value)}
          placeholder="chess-master"
          className="field-input"
        />
        {appKey && !keyValid && (
          <p className="mt-1.5 text-xs text-saffron-700">
            Lowercase letters, digits, and hyphens only; must start with a letter; 2-50 characters.
          </p>
        )}
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

      <p className="text-sm text-chakra-500">
        The app is created as a draft. Short description, icon, category, and
        owning team can be filled in on the edit screen before activation.
      </p>

      <button type="submit" disabled={!canSubmit} className="btn-primary">
        {submitting ? "Creating…" : "Create draft app"}
      </button>
    </form>
  );
}
