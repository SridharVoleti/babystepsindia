import type { Metadata } from "next";
import { requireLearnerMode } from "@/lib/auth/guards";
import { listAchievements } from "@/lib/achievements/service";
import { AchievementHistory } from "@/components/achievements/achievement-history";

export const metadata: Metadata = { title: "Achievements â€” Baby Steps" };

export default async function LearnerAchievementsPage() {
  const { authorization } = await requireLearnerMode();
  const page = listAchievements({ learnerId: authorization.learnerId!, limit: 20 });
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
    <a href="/learner" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">
      Back to learning apps
    </a>
    <p className="mt-6 text-sm font-semibold text-green-700">Learning mode</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">Achievements</h1>
    <p className="mt-2 text-chakra-600">A history of achievements earned in each learning app.</p>
    <AchievementHistory initialAchievements={page.achievements} initialCursor={page.nextCursor}
      endpoint="/v1/learner-achievements" />
  </main>;
}
