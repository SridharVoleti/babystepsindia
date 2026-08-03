import { describe, expect, it } from "vitest";
import { invoiceRecipientLabel } from "@/lib/parent-profile/invoice";

describe("invoiceRecipientLabel (AT-IA-002-11/12)", () => {
  it("uses the display name when present", () => {
    expect(invoiceRecipientLabel("Asha Verma", "asha@example.com")).toBe("Asha Verma");
  });

  it("trims surrounding whitespace on the display name", () => {
    expect(invoiceRecipientLabel("  Asha Verma  ", "asha@example.com")).toBe("Asha Verma");
  });

  it("falls back to the authenticated email when the name is null", () => {
    expect(invoiceRecipientLabel(null, "asha@example.com")).toBe("asha@example.com");
  });

  it("falls back to the authenticated email when the name is blank/whitespace-only", () => {
    expect(invoiceRecipientLabel("   ", "asha@example.com")).toBe("asha@example.com");
    expect(invoiceRecipientLabel("", "asha@example.com")).toBe("asha@example.com");
  });

  it("never returns a blank label", () => {
    expect(invoiceRecipientLabel(undefined, "asha@example.com")).toBe("asha@example.com");
  });
});
