"use client";

import { useState } from "react";
import type { AdminLearnerAppRow } from "@/lib/db/learner-app-admin-repo";

// <input type="datetime-local"> wants local "YYYY-MM-DDTHH:mm", not an ISO instant.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  LEARNER_APP_VERSION_CONFLICT: "This row changed elsewhere — reload and try again.",
  SESSION_LIMIT_OVERRIDE_INVALID: "Extra sessions must be a positive whole number.",
  ACCESS_END_INVALID: "Enter a valid date and time.",
  ACCESS_END_BEFORE_PERIOD_START: "The end date must be after the entitlement period's start.",
  NO_ENTITLEMENT_PERIOD: "This learner has no entitlement period for this app to edit.",
  LEARNER_APP_NOT_FOUND: "This learner/app no longer exists.",
};

export function LearnerAppRow({ row: initialRow }: { row: AdminLearnerAppRow }) {
  const [row, setRow] = useState(initialRow);
  const [unlimited, setUnlimited] = useState(initialRow.unlimitedSessions);
  const [overrideText, setOverrideText] = useState(initialRow.weeklySessionLimitOverride?.toString() ?? "");
  const [endText, setEndText] = useState(toLocalInput(initialRow.accessUntil ?? initialRow.latestPeriodEnd));
  const [saving, setSaving] = useState<"limit" | "end" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const parsedOverride = overrideText.trim() === "" ? null : Number(overrideText);
  const overrideValid = parsedOverride === null || (Number.isInteger(parsedOverride) && parsedOverride >= 1);
  const limitChanged = unlimited !== row.unlimitedSessions || parsedOverride !== row.weeklySessionLimitOverride;
  const endChanged = endText !== "" && endText !== toLocalInput(row.accessUntil ?? row.latestPeriodEnd);
  const base = `/v1/admin/learner-apps/${row.learnerId}/${row.appId}`;

  async function patch(kind: "limit" | "end", path: string, body: unknown) {
    setSaving(kind);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`${base}/${path}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(ERROR_MESSAGES[result.error] ?? "Unable to save. Please try again.");
        return null;
      }
      return result;
    } catch {
      setError("Unable to save. Please try again.");
      return null;
    } finally {
      setSaving(null);
    }
  }

  async function saveLimit() {
    if (!overrideValid || !limitChanged) return;
    const result = await patch("limit", "session-limit", {
      unlimitedSessions: unlimited,
      weeklySessionLimitOverride: unlimited ? null : parsedOverride,
      expectedVersion: row.sessionLimitVersion,
    });
    if (!result) return;
    setRow({ ...row, unlimitedSessions: unlimited, weeklySessionLimitOverride: unlimited ? null : parsedOverride,
      sessionLimitIsAppSpecific: true, sessionLimitVersion: result.version });
    setMessage("Session cap saved.");
  }

  async function saveEnd() {
    if (!endChanged) return;
    const result = await patch("end", "access-end", { accessEnd: new Date(endText).toISOString() });
    if (!result) return;
    setRow({ ...row, accessUntil: result.accessUntil, latestPeriodEnd: new Date(endText).toISOString() });
    setMessage("Access end saved.");
  }

  return (
    <div className="space-y-3 p-5">
      <div>
        <p className="font-medium text-chakra-900">{row.learnerName}</p>
        <p className="mt-0.5 text-xs text-chakra-400">{row.ownerParentEmail}</p>
        {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
        {message && !error && <p role="status" className="mt-1 text-xs text-green-700">{message}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-chakra-700">
          <input type="checkbox" checked={unlimited}
            onChange={(event) => { setUnlimited(event.target.checked); setMessage(null); }} />
          Unlimited sessions
        </label>
        <label className="flex items-center gap-2 text-sm text-chakra-700">
          Sessions/week
          <input type="number" min={1} step={1} className="field-input w-20"
            placeholder="2 (default)" value={overrideText} disabled={unlimited}
            onChange={(event) => { setOverrideText(event.target.value); setMessage(null); }} />
        </label>
        <button type="button" className="btn-secondary py-1.5 text-xs"
          disabled={!limitChanged || !overrideValid || saving !== null} onClick={saveLimit}>
          {saving === "limit" ? "Saving…" : "Save cap"}
        </button>
        {!row.sessionLimitIsAppSpecific && (
          <span className="text-xs text-chakra-400">inherited from learner</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-chakra-700">
          Access ends
          <input type="datetime-local" className="field-input" value={endText}
            onChange={(event) => { setEndText(event.target.value); setMessage(null); }} />
        </label>
        <button type="button" className="btn-secondary py-1.5 text-xs"
          disabled={!endChanged || saving !== null} onClick={saveEnd}>
          {saving === "end" ? "Saving…" : "Save end date"}
        </button>
        {row.accessUntil === null && (
          <span className="text-xs text-chakra-400">currently no active access</span>
        )}
      </div>
    </div>
  );
}
