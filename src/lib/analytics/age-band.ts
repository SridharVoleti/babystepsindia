import { calculateAge } from "@/lib/learner-profile/validation";
import type { AgeBand } from "@/lib/db/types";

// Business rule 8: age is derived from restricted DOB for the activity
// date and immediately converted to one approved band — the exact age
// value never leaves this function.
const BAND_MAX_YEARS: ReadonlyArray<{ maxYears: number; band: AgeBand }> = [
  { maxYears: 5, band: "under_6" },
  { maxYears: 7, band: "6_7" },
  { maxYears: 9, band: "8_9" },
  { maxYears: 12, band: "10_12" },
  { maxYears: 15, band: "13_15" },
  { maxYears: 18, band: "16_18" },
  { maxYears: 29, band: "19_29" },
  { maxYears: 49, band: "30_49" },
];

export function deriveAgeBand(dateOfBirth: string, activityDate: string): AgeBand {
  const { ageYears } = calculateAge(dateOfBirth, activityDate);
  for (const { maxYears, band } of BAND_MAX_YEARS) {
    if (ageYears <= maxYears) return band;
  }
  return "50_plus";
}
