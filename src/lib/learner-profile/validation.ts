export class LearnerValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LearnerValidationError";
  }
}

function visibleCharacterCount(value: string): number {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
  }
  return Array.from(value).length;
}

// ECMAScript has no built-in full Unicode CaseFolding operation. Lowercase is
// locale-independent here; the two multi-code-point folds below cover the
// common characters where lowercasing alone differs from Unicode case fold.
function caseFold(value: string): string {
  return value.toLowerCase().replace(/ß/g, "ss").replace(/ς/g, "σ");
}

export function normalizeLearnerName(value: string): {
  displayName: string;
  normalizedDisplayName: string;
} {
  const displayName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!displayName) throw new LearnerValidationError("DISPLAY_NAME_REQUIRED");
  if (/\p{Cc}/u.test(displayName) || visibleCharacterCount(displayName) > 50) {
    throw new LearnerValidationError("DISPLAY_NAME_INVALID");
  }
  return { displayName, normalizedDisplayName: caseFold(displayName) };
}

function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

export function validateDateOfBirth(value: string, ageAsOfDate: string): string {
  const birth = parseCalendarDate(value);
  const asOf = parseCalendarDate(ageAsOfDate);
  if (!birth) throw new LearnerValidationError("DATE_OF_BIRTH_INVALID");
  if (!asOf) throw new Error("Invalid ageAsOfDate");
  if (value > ageAsOfDate) throw new LearnerValidationError("DATE_OF_BIRTH_FUTURE");
  return value;
}

export function calculateAge(dateOfBirth: string, ageAsOfDate: string): {
  ageYears: number;
  ageMonths: number;
} {
  validateDateOfBirth(dateOfBirth, ageAsOfDate);
  const birth = parseCalendarDate(dateOfBirth)!;
  const asOf = parseCalendarDate(ageAsOfDate)!;
  let totalMonths = (asOf.year - birth.year) * 12 + asOf.month - birth.month;
  if (asOf.day < birth.day) totalMonths -= 1;
  return { ageYears: Math.floor(totalMonths / 12), ageMonths: totalMonths % 12 };
}
