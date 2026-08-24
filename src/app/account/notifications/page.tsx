import type { Metadata } from "next";
import Link from "next/link";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentNotificationPreferences } from "@/lib/notification-preferences/service";
import { LearningReminderPreference } from "@/components/account/learning-reminder-preference";

export const metadata: Metadata = { title: "Notification settings — Baby Steps" };

// NT-003: one canonical Notifications settings page (rule 1/6/96-97) —
// mandatory categories are rendered as plain status text, never a
// disabled-look toggle (rule 23/94-95: a disabled control would falsely
// imply the parent could enable/disable it elsewhere).
export default async function NotificationSettingsPage() {
  const { session } = await requireParentManagement();
  const preferences = await composeParentNotificationPreferences(session.sub);
  const mandatory = preferences.categories.filter((category) => category.required);
  const learning = preferences.categories.find((category) => category.key === "learning_reminders")!;

  return <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:px-6 sm:py-16">
    <Link href="/account" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">
      ← Account
    </Link>
    <h1 className="mt-4 text-2xl font-bold text-chakra-900">Notification settings</h1>
    <p className="mt-2 text-sm text-chakra-600">
      Important account and billing emails are always sent. You can choose whether to receive learning reminders.
    </p>
    {preferences.destination.verifiedEmailHint && (
      <p className="mt-1 text-xs text-chakra-500">Sent to {preferences.destination.verifiedEmailHint}</p>
    )}

    <section aria-labelledby="mandatory-communications-heading" className="mt-6 card p-5">
      <h2 id="mandatory-communications-heading" className="text-lg font-semibold text-chakra-900">
        Mandatory communications
      </h2>
      <ul className="mt-3 divide-y divide-chakra-100">
        {mandatory.map((category) => (
          <li key={category.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <p className="font-medium text-chakra-900">{category.label}</p>
              <p className="mt-0.5 text-sm text-chakra-600">{category.description}</p>
            </div>
            <span className="shrink-0 text-sm font-semibold text-chakra-700">{category.status}</span>
          </li>
        ))}
      </ul>
    </section>

    <section aria-labelledby="optional-reminders-heading" className="mt-6">
      <h2 id="optional-reminders-heading" className="text-lg font-semibold text-chakra-900">Optional reminders</h2>
      <div className="mt-3">
        <LearningReminderPreference initialEnabled={!!learning.enabled} initialVersion={preferences.preferenceVersion} />
      </div>
    </section>

    <div className="mt-8 border-t border-chakra-100 pt-6">
      <Link href={preferences.communicationHistoryRoute}
        className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
        View communication history →
      </Link>
      <p className="mt-1 text-xs text-chakra-500">A record of important account and billing emails from the last 13 months.</p>
    </div>
  </main>;
}
