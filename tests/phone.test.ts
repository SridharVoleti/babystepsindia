import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/parent-profile/phone";

describe("normalizePhone", () => {
  it("normalizes a valid Indian mobile number to E.164", () => {
    const result = normalizePhone("IN", "9876543210");
    expect(result).toEqual({ ok: true, e164: "+919876543210" });
  });

  it("normalizes differently formatted input to the same canonical value (AT-IA-002-02)", () => {
    const a = normalizePhone("IN", "98765 43210");
    const b = normalizePhone("IN", "+91 98765 43210");
    const c = normalizePhone("IN", "9876543210");
    expect(a).toEqual({ ok: true, e164: "+919876543210" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("normalizes valid numbers for other supported countries", () => {
    expect(normalizePhone("US", "2015550123")).toEqual({ ok: true, e164: "+12015550123" });
    expect(normalizePhone("GB", "7911123456")).toEqual({ ok: true, e164: "+447911123456" });
  });

  it("rejects a number that's too short for the country (AT-IA-002-04)", () => {
    const result = normalizePhone("IN", "12345");
    expect(result.ok).toBe(false);
  });

  it("rejects a number valid in one country but parsed against the wrong one", () => {
    // A US-shaped number is not a valid Indian mobile number.
    const result = normalizePhone("IN", "2015550123");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty number", () => {
    const result = normalizePhone("IN", "");
    expect(result.ok).toBe(false);
  });

  it("rejects an unrecognized country code without throwing", () => {
    const result = normalizePhone("ZZ" as never, "9876543210");
    expect(result.ok).toBe(false);
  });
});
