import { describe, expect, it } from "vitest";
import { maskPhone } from "@/lib/parent-profile/mask";

describe("maskPhone (AT-IA-002-13)", () => {
  it("hides all but the last two digits, keeping the leading +", () => {
    expect(maskPhone("+919876543210")).toBe("+••••••••••10");
  });

  it("never reveals the full number in its output", () => {
    const masked = maskPhone("+14155552671");
    expect(masked).not.toContain("552671");
    expect(masked.endsWith("71")).toBe(true);
    expect(masked.startsWith("+")).toBe(true);
  });

  it("returns a placeholder for a null/missing number rather than throwing", () => {
    expect(maskPhone(null)).toBe("—");
    expect(maskPhone(undefined)).toBe("—");
  });
});
