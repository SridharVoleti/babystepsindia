export type EngagedDateChunk = { activityDate: string; engagedSeconds: number };

const KOLKATA_OFFSET_MS = (5 * 60 + 30) * 60_000;

export function kolkataCalendarDate(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new Error("INVALID_INSTANT");
  return new Date(instant.getTime() + KOLKATA_OFFSET_MS).toISOString().slice(0, 10);
}

function nextKolkataMidnight(activityDate: string): Date {
  const [year, month, day] = activityDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1) - KOLKATA_OFFSET_MS);
}

// AN-001 AC14: accepted connected time is a contiguous, integer-second
// interval beginning at the platform's active-segment checkpoint. Split it
// at Kolkata midnight before deriving daily pseudonyms or writing buffers.
export function splitKolkataEngagedSeconds(start: Date, engagedSeconds: number): EngagedDateChunk[] {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) throw new Error("INVALID_INTERVAL_START");
  if (!Number.isInteger(engagedSeconds) || engagedSeconds < 0) throw new Error("INVALID_ENGAGED_SECONDS");
  if (engagedSeconds === 0) return [];

  const chunks: EngagedDateChunk[] = [];
  let cursor = new Date(start);
  let remaining = engagedSeconds;
  while (remaining > 0) {
    const activityDate = kolkataCalendarDate(cursor);
    const boundary = nextKolkataMidnight(activityDate);
    const secondsUntilBoundary = Math.max(0, Math.floor((boundary.getTime() - cursor.getTime()) / 1000));
    const chunkSeconds = secondsUntilBoundary === 0 ? remaining : Math.min(remaining, secondsUntilBoundary);
    chunks.push({ activityDate, engagedSeconds: chunkSeconds });
    remaining -= chunkSeconds;
    cursor = secondsUntilBoundary === 0
      ? boundary
      : new Date(cursor.getTime() + chunkSeconds * 1000);
  }
  return chunks;
}
