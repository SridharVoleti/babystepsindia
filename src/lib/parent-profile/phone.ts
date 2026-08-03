// The "/max" (full metadata) build classifies numbers by real prefix
// ranges rather than length alone — the default "min" build treats
// e.g. "2015550123" as a plausible Indian number, which it isn't
// (Indian mobile numbers start 6-9). IA-002 explicitly calls for a
// maintained library "rather than custom regular expressions alone";
// the fuller metadata is what makes that guarantee hold in practice.
import { parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js/max";

export type NormalizePhoneResult =
  | { ok: true; e164: string }
  | { ok: false; error: string };

// IA-002 business rule 3/4: parsed and validated using a maintained
// libphonenumber-compatible library (not custom regex), normalized to
// E.164. Deliberately no OTP/SMS step — format validation only.
export function normalizePhone(countryCode: string, rawNumber: string): NormalizePhoneResult {
  if (!rawNumber.trim()) {
    return { ok: false, error: "Enter a mobile number." };
  }

  try {
    const parsed = parsePhoneNumberWithError(rawNumber, countryCode as CountryCode);
    if (!parsed.isValid()) {
      return { ok: false, error: "Enter a valid mobile number for the selected country." };
    }
    return { ok: true, e164: parsed.number };
  } catch {
    return { ok: false, error: "Enter a valid mobile number for the selected country." };
  }
}
