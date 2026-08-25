"use client";

import Link from "next/link";
import { useState } from "react";

export function AddLearnerForm({
  avatars,
  maxDate,
}: {
  avatars: Array<{ id: string; label: string }>;
  maxDate: string;
}) {
  const [displayName, setDisplayName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/v1/learners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          dateOfBirth,
          avatarId,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages: Record<string, string> = {
          LEARNER_NAME_ALREADY_EXISTS: "You already have a learner with this name.",
          DISPLAY_NAME_INVALID: "Enter a valid name.",
          DATE_OF_BIRTH_INVALID: "Enter a valid date of birth.",
          DATE_OF_BIRTH_FUTURE: "Date of birth cannot be in the future.",
          AVATAR_NOT_AVAILABLE: "That avatar is no longer available.",
        };
        setError(messages[result.error] ?? "Unable to add this learner. Please try again.");
        return;
      }
      window.location.href = "/account/learners";
    } catch {
      setError("Unable to add this learner. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-5 p-6">
      {error && <p role="alert" className="rounded-lg bg-saffron-50 p-3 text-sm text-saffron-800">{error}</p>}
      <div>
        <label className="field-label" htmlFor="displayName">Display name</label>
        <input id="displayName" className="field-input" value={displayName} maxLength={50}
          onChange={(event) => setDisplayName(event.target.value)} required />
        <p className="mt-1.5 text-xs text-chakra-400">Must be unique within your learner list.</p>
      </div>
      <div>
        <label className="field-label" htmlFor="dateOfBirth">Date of birth</label>
        <input id="dateOfBirth" type="date" className="field-input" value={dateOfBirth} max={maxDate}
          onChange={(event) => setDateOfBirth(event.target.value)} required />
      </div>
      <div>
        <label className="field-label" htmlFor="avatarId">Avatar (optional)</label>
        <select id="avatarId" className="field-input" value={avatarId ?? ""}
          onChange={(event) => setAvatarId(event.target.value || null)}>
          <option value="">No avatar</option>
          {avatars.map((avatar) => <option key={avatar.id} value={avatar.id}>{avatar.label}</option>)}
        </select>
      </div>
      <div className="flex gap-3">
        <button type="submit" className="btn-primary" disabled={!displayName || !dateOfBirth || submitting}>
          {submitting ? "Adding…" : "Add learner"}
        </button>
        <Link href="/account/learners" className="btn-secondary">Cancel</Link>
      </div>
    </form>
  );
}
