"use client";

import { useState } from "react";

export function LearningReminderPreference(props: { initialEnabled: boolean; initialVersion: number }) {
  const [enabled, setEnabled] = useState(props.initialEnabled);
  const [version, setVersion] = useState(props.initialVersion);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function toggle() {
    if (status === "saving") return;
    const next = !enabled; setStatus("saving");
    try {
      const response = await fetch("/v1/parent/notification-preferences", { method: "PATCH",
        credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" },
        body: JSON.stringify({ learningReminderEmailEnabled: next, expectedVersion: version,
          idempotencyKey: crypto.randomUUID() }) });
      if (!response.ok) throw new Error("save failed");
      // NT-003 API-NT-009: the PATCH response is the full NotificationPreferences
      // contract, not a bare {learningReminderEmailEnabled,version} pair —
      // the learning-reminders category carries the current enabled state.
      const result = await response.json() as {
        preferenceVersion: number;
        categories: Array<{ key: string; enabled?: boolean }>;
      };
      const learning = result.categories.find((category) => category.key === "learning_reminders");
      setEnabled(learning?.enabled ?? next); setVersion(result.preferenceVersion); setStatus("saved");
    } catch { setStatus("error"); }
  }

  return <section aria-labelledby="learning-reminders-heading" className="card p-5">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <h2 id="learning-reminders-heading" className="text-lg font-semibold text-chakra-900">Learning reminders</h2>
        <p className="mt-2 text-sm text-chakra-600">
          We’ll email you—not the learner—when normal weekly learning sessions remain. These gentle reminders are
          separate from billing, security, and account messages.
        </p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label="Learning reminder emails"
        onClick={toggle} disabled={status === "saving"}
        className="min-h-[44px] min-w-[120px] rounded-lg border border-chakra-300 px-4 py-2 text-sm font-semibold text-chakra-900 disabled:opacity-60">
        {status === "saving" ? "Saving…" : enabled ? "Email on" : "Email off"}
      </button>
    </div>
    <p role="status" aria-live="polite" className="mt-3 text-sm text-chakra-500">
      {status === "saved" ? "Preference saved." : status === "error" ? "Could not save. Please try again." : ""}
    </p>
  </section>;
}
