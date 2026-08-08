import {
  getCountries,
  getCountryCallingCode,
  type CountryCode,
} from "libphonenumber-js/max";

export type CountryOption = {
  code: CountryCode;
  name: string;
  callingCode: string;
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Keep the selector in lockstep with the maintained parser metadata. This
// prevents the UI from artificially limiting the international numbers the
// server already validates, while the India-first product default remains
// explicit through DEFAULT_PHONE_COUNTRY.
export const PHONE_COUNTRIES: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: regionNames.of(code) ?? code,
    callingCode: `+${getCountryCallingCode(code)}`,
  }))
  .sort((left, right) => left.name.localeCompare(right.name, "en"));

export const DEFAULT_PHONE_COUNTRY: CountryCode = "IN";
