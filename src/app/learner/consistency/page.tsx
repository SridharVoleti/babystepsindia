import type { Metadata } from "next";
import { requireLearnerMode } from "@/lib/auth/guards";
import { listConsistency } from "@/lib/consistency/service";
import { ConsistencyHistory } from "@/components/consistency/consistency-history";

export const metadata: Metadata = { title: "Weekly consistency — Baby Steps" };

export default async function LearnerConsistencyPage() {
  const { authorization } = await requireLearnerMode();
  const page = await listConsistency({ learnerId: authorization.learnerId!, limit: 20 });
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
    <a href="/learner" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">
      Back to learning apps
    </a>
    <p className="mt-6 text-sm font-semibold text-green-700">Learning mode</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">Weekly consistency</h1>
    <p className="mt-2 text-chakra-600">Two normal sessions in an app complete that app&apos;s week. There is no daily or combined streak.</p>
    <ConsistencyHistory apps={page.apps} initialHistory={page.history} initialCursor={page.nextCursor}
      endpoint="/v1/learner-consistency" />
  </main>;
}
