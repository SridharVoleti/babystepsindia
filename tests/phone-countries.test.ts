import { describe, expect, it } from "vitest";
import { getCountries } from "libphonenumber-js/max";
import { DEFAULT_PHONE_COUNTRY, PHONE_COUNTRIES } from "@/lib/parent-profile/countries";

describe("IA-002 international phone country options", () => {
  it("exposes every country supported by the maintained phone parser", () => {
    expect(PHONE_COUNTRIES.map((country) => country.code).sort()).toEqual(getCountries().sort());
  });

  it("includes representative regions while retaining India as the default", () => {
    expect(DEFAULT_PHONE_COUNTRY).toBe("IN");
    expect(PHONE_COUNTRIES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BR", callingCode: "+55" }),
        expect.objectContaining({ code: "JP", callingCode: "+81" }),
        expect.objectContaining({ code: "ZA", callingCode: "+27" }),
      ]),
    );
  });
});
