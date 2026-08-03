import { describe, expect, it } from "vitest";
import { maskEmail } from "@/lib/account/mask";

describe("maskEmail (AC15)", () => {
  it("keeps the first local-part character and the full domain visible", () => {
    expect(maskEmail("asha.verma@example.com")).toBe("a•••••••••@example.com");
  });

  it("never reveals the rest of the local part", () => {
    const masked = maskEmail("parent@example.com");
    expect(masked).not.toContain("arent");
    expect(masked.endsWith("@example.com")).toBe(true);
  });

  it("returns a placeholder for a null/missing email", () => {
    expect(maskEmail(null)).toBe("—");
    expect(maskEmail(undefined)).toBe("—");
  });
});
