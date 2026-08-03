// Curated, not exhaustive — libphonenumber-js supports the full ISO list,
// but a 240-option dropdown is worse UX than a short list covering
// Babysteps' actual markets plus a few common ones. "IN" is first/default
// since the product targets India (locale default en-IN, timezone
// Asia/Kolkata).
export type CountryOption = { code: string; name: string; callingCode: string };

export const PHONE_COUNTRIES: CountryOption[] = [
  { code: "IN", name: "India", callingCode: "+91" },
  { code: "US", name: "United States", callingCode: "+1" },
  { code: "GB", name: "United Kingdom", callingCode: "+44" },
  { code: "AE", name: "United Arab Emirates", callingCode: "+971" },
  { code: "CA", name: "Canada", callingCode: "+1" },
  { code: "AU", name: "Australia", callingCode: "+61" },
  { code: "SG", name: "Singapore", callingCode: "+65" },
  { code: "NZ", name: "New Zealand", callingCode: "+64" },
];

export const DEFAULT_PHONE_COUNTRY = "IN";
