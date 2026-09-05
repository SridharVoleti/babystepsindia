"use client";

import { useState } from "react";
import type { AdminLearnerRow } from "@/lib/db/learner-repo";

export function LearnerSessionLimitRow({ learner: initialLearner }: { learner: AdminLearnerRow }) {
  const [learner, setLearner] = useState(initialLearner);
  const [unlimitedSessions, setUnlimitedSessions] = useState(initialLearner.unlimitedSessions);
  const [overrideText, setOverrideText] = useState(
    initialLearner.weeklySessionLimitOverride?.toString() ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsedOverride = overrideText.trim() === "" ? null : Number(overrideText);
  const overrideValid = parsedOverride === null || (Number.isInteger(parsedOverride) && parsedOverride >= 1);

  const changed = unlimitedSessions !== learner.unlimitedSessions ||
    parsedOverride !== learner.weeklySessionLimitOverride;

  async function save() {
    if (!overrideValid || !changed) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/v1/admin/learners/${learner.id}/session-limit`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          unlimitedSessions,
          weeklySessionLimitOverride: unlimitedSessions ? null : parsedOverride,
          expectedVersion: learner.version,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const messages: Record<string, string> = {
          LEARNER_VERSION_CONFLICT: "This learner changed elsewhere — reload and try again.",
          SESSION_LIMIT_OVERRIDE_INVALID: "Extra sessions must be a positive whole number.",
        };
        setError(messages[result.error] ?? "Unable to save. Please try again.");
        return;
      }
      setLearner(result.learner);
      setUnlimitedSessions(result.learner.unlimitedSessions);
      setOverrideText(result.learner.weeklySessionLimitOverride?.toString() ?? "");
      setSaved(true);
    } catch {
      setError("Unable to save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 p-5">
      <div>
        <p className="font-medium text-chakra-900">{learner.displayName}</p>
        <p className="mt-0.5 text-xs text-chakra-400">{learner.ownerParentEmail}</p>
        {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
        {saved && !changed && <p role="status" className="mt-1 text-xs text-green-700">Saved.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-chakra-700">
          <input
            type="checkbox"
            checked={unlimitedSessions}
            onChange={(event) => { setUnlimitedSessions(event.target.checked); setSaved(false); }}
          />
          Unlimited sessions
        </label>

        <label className="flex items-center gap-2 text-sm text-chakra-700">
          Extra sessions/week
          <input
            type="number"
            min={1}
            step={1}
            className="field-input w-20"
            placeholder="2 (default)"
            value={overrideText}
            disabled={unlimitedSessions}
            onChange={(event) => { setOverrideText(event.target.value); setSaved(false); }}
          />
        </label>

        <button
          type="button"
          className="btn-secondary py-1.5 text-xs"
          disabled={!changed || !overrideValid || saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
