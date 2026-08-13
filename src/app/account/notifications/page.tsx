import type { Metadata } from "next";
import Link from "next/link";
import { requireParentManagement } from "@/lib/auth/guards";
import { getParentNotificationPreference } from "@/lib/learning-reminders/service";
import { LearningReminderPreference } from "@/components/account/learning-reminder-preference";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = { title: "Notification settings — Baby Steps" };

export default async function NotificationSettingsPage() {
  const { session } = await requireParentManagement();
  const preference = getParentNotificationPreference(session.sub);
  return <div className="flex min-h-screen flex-col">
    <SiteHeader />
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10 sm:px-6 sm:py-16">
      <Link href="/account" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">
        ← Account
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-chakra-900">Notification settings</h1>
      <p className="mt-2 text-sm text-chakra-600">Choose whether you receive parent learning-cadence emails.</p>
      <div className="mt-6"><LearningReminderPreference initialEnabled={preference.learningReminderEmailEnabled}
        initialVersion={preference.version} /></div>
    </main>
    <SiteFooter />
  </div>;
}
