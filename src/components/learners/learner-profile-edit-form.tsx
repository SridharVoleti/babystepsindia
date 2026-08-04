"use client";

import Link from "next/link";
import { useState } from "react";

type EditableLearner = {
  id: string;
  displayName: string;
  dateOfBirth: string;
  avatarId: string | null;
  version: number;
};

export function LearnerProfileEditForm({
  initialLearner,
  avatars,
}: {
  initialLearner: EditableLearner;
  avatars: Array<{ id: string; label: string }>;
}) {
  const [saved, setSaved] = useState(initialLearner);
  const [displayName, setDisplayName] = useState(initialLearner.displayName);
  const [dateOfBirth, setDateOfBirth] = useState(initialLearner.dateOfBirth);
  const [avatarId, setAvatarId] = useState<string | null>(initialLearner.avatarId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const changed = displayName !== saved.displayName ||
    dateOfBirth !== saved.dateOfBirth || avatarId !== saved.avatarId;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!changed) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    const body: Record<string, unknown> = {
      expectedVersion: saved.version,
      idempotencyKey: crypto.randomUUID(),
    };
    if (displayName !== saved.displayName) body.displayName = displayName;
    if (dateOfBirth !== saved.dateOfBirth) body.dateOfBirth = dateOfBirth;
    if (avatarId !== saved.avatarId) body.avatarId = avatarId;

    try {
      const response = await fetch(`/v1/learners/${saved.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (result.error === "LEARNER_VERSION_CONFLICT") {
          setError("This profile changed elsewhere. Reload the page and review the latest values.");
        } else {
          const messages: Record<string, string> = {
            LEARNER_NAME_ALREADY_EXISTS: "Another learner already uses this display name.",
            DATE_OF_BIRTH_INVALID: "Enter a valid date of birth.",
            DATE_OF_BIRTH_FUTURE: "Date of birth cannot be in the future.",
            AVATAR_NOT_AVAILABLE: "That avatar is no longer available.",
          };
          setError(messages[result.error] ?? "Unable to update the profile. Please try again.");
        }
        return;
      }
      const next: EditableLearner = {
        id: result.learner.id,
        displayName: result.learner.displayName,
        dateOfBirth: result.learner.dateOfBirth,
        avatarId: result.learner.avatarId,
        version: result.learner.version,
      };
      setSaved(next);
      setDisplayName(next.displayName);
      setDateOfBirth(next.dateOfBirth);
      setAvatarId(next.avatarId);
      setSuccess(true);
    } catch {
      setError("Unable to update the profile. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="card mt-6 space-y-5 p-6">
      {error && <p role="alert" className="rounded-lg bg-saffron-50 p-3 text-sm text-saffron-800">{error}</p>}
      {success && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">Profile updated.</p>}
      <div>
        <label className="field-label" htmlFor="displayName">Display name</label>
        <input id="displayName" className="field-input" value={displayName} maxLength={50}
          onChange={(event) => setDisplayName(event.target.value)} required />
        <p className="mt-1.5 text-xs text-chakra-400">Must be unique within your learner list.</p>
      </div>
      <div>
        <label className="field-label" htmlFor="dateOfBirth">Date of birth</label>
        <input id="dateOfBirth" type="date" className="field-input" value={dateOfBirth}
          onChange={(event) => setDateOfBirth(event.target.value)} required />
      </div>
      <div>
        <label className="field-label" htmlFor="avatarId">Avatar</label>
        <select id="avatarId" className="field-input" value={avatarId ?? ""}
          onChange={(event) => setAvatarId(event.target.value || null)}>
          <option value="">Remove avatar</option>
          {avatars.map((avatar) => <option key={avatar.id} value={avatar.id}>{avatar.label}</option>)}
        </select>
      </div>
      <div className="flex gap-3">
        <button type="submit" className="btn-primary" disabled={!changed || submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <Link href="/account" className="btn-secondary">Cancel</Link>
      </div>
    </form>
  );
}
