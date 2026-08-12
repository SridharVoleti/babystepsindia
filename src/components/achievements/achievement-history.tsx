"use client";

import { useState } from "react";
import type { AchievementView } from "@/lib/achievements/service";

export function AchievementHistory({ initialAchievements, initialCursor, endpoint }: {
  initialAchievements: AchievementView[];
  initialCursor: string | null;
  endpoint: string;
}) {
  const [achievements, setAchievements] = useState(initialAchievements);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true); setError(null);
    try {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = await fetch(`${endpoint}${separator}cursor=${encodeURIComponent(cursor)}`, {
        credentials: "same-origin", cache: "no-store",
      });
      if (!response.ok) throw new Error("request_failed");
      const page = await response.json() as { achievements: AchievementView[]; nextCursor: string | null };
      setAchievements((current) => [...current, ...page.achievements.filter((item) =>
        !current.some((existing) => existing.achievementId === item.achievementId))]);
      setCursor(page.nextCursor);
    } catch {
      setError("Achievements could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (achievements.length === 0) return <section className="card mt-6 p-6">
    <h2 className="text-lg font-semibold text-chakra-900">No achievements yet</h2>
    <p className="mt-2 text-sm text-chakra-600">Achievements earned in learning apps will appear here.</p>
  </section>;

  return <section className="mt-6" aria-label="Achievement history">
    <ul className="grid grid-cols-1 gap-4">
      {achievements.map((achievement) => <li key={achievement.achievementId}
        className="card flex items-start gap-4 p-5">
        <span aria-hidden="true" className="text-3xl text-yellow-600">&#9733;</span>
        <div className="min-w-0">
          <h2 className="font-semibold text-chakra-900">{achievement.title}</h2>
          <p className="mt-1 text-sm text-chakra-600">{achievement.appName}</p>
          <p className="mt-1 text-sm text-chakra-500">Earned {new Date(achievement.earnedAt).toLocaleString()}</p>
          {achievement.shortDescription && <p className="mt-2 text-sm text-chakra-700">{achievement.shortDescription}</p>}
          <p className="mt-2 text-xs capitalize text-chakra-500">{achievement.category}</p>
        </div>
      </li>)}
    </ul>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {cursor && <button type="button" className="btn-secondary mt-5 min-h-[44px]" disabled={loading} onClick={loadMore}>
      {loading ? "Loading..." : "Load more"}
    </button>}
  </section>;
}
