import { describe, expect, it } from "vitest";
import {
  AppRegistryError,
  assertOnlyMutableFields,
  computeRequestHash,
  validateAppKey,
  validateDisplayName,
  validateShortDescription,
} from "@/lib/app-registry/validation";

describe("validateAppKey", () => {
  it("accepts a compliant lowercase hyphenated key", () => {
    expect(validateAppKey("chess-master")).toBe("chess-master");
  });

  it.each([
    ["", "empty"],
    ["A", "single uppercase char"],
    ["1abc", "starts with a digit"],
    ["ab_cd", "underscore"],
    ["ab cd", "space"],
    ["a".repeat(51), "over 50 chars"],
    ["a", "under 2 chars"],
  ])("rejects %s (%s)", (key) => {
    expect(() => validateAppKey(key)).toThrowError(new AppRegistryError("APP_KEY_INVALID"));
  });

  it("accepts the 2-char and 50-char boundary lengths", () => {
    expect(validateAppKey("ab")).toBe("ab");
    expect(validateAppKey("a" + "b".repeat(49))).toHaveLength(50);
  });
});

describe("validateDisplayName", () => {
  it("trims and accepts 1-80 visible characters", () => {
    expect(validateDisplayName("  Chess Master  ")).toBe("Chess Master");
  });

  it("rejects blank or over-80-character names", () => {
    expect(() => validateDisplayName("   ")).toThrowError(new AppRegistryError("APP_METADATA_INVALID"));
    expect(() => validateDisplayName("a".repeat(81))).toThrowError(
      new AppRegistryError("APP_METADATA_INVALID"),
    );
  });
});

describe("validateShortDescription", () => {
  it("trims and accepts 1-240 characters", () => {
    expect(validateShortDescription("  Guided chess lessons.  ")).toBe("Guided chess lessons.");
  });

  it("rejects blank or over-240-character descriptions", () => {
    expect(() => validateShortDescription("")).toThrowError(new AppRegistryError("APP_METADATA_INVALID"));
    expect(() => validateShortDescription("a".repeat(241))).toThrowError(
      new AppRegistryError("APP_METADATA_INVALID"),
    );
  });
});

describe("assertOnlyMutableFields", () => {
  it("allows the documented mutable fields plus operation envelope keys", () => {
    expect(() =>
      assertOnlyMutableFields({
        displayName: "x",
        shortDescription: "y",
        iconAssetKey: "icon-1",
        category: "learning",
        owningTeam: "platform",
        internalNotes: "note",
        expectedVersion: 1,
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
      }),
    ).not.toThrow();
  });

  it("rejects protected/unknown fields (AT-AR-001-27)", () => {
    for (const field of ["id", "appKey", "registryStatus", "version", "createdAt", "updatedAt", "notAField"]) {
      expect(() => assertOnlyMutableFields({ [field]: "x" })).toThrowError(
        new AppRegistryError("FORBIDDEN_FIELD"),
      );
    }
  });
});

describe("computeRequestHash", () => {
  it("is stable for the same payload regardless of key order", () => {
    const a = computeRequestHash({ displayName: "Chess Master", category: "learning" });
    const b = computeRequestHash({ category: "learning", displayName: "Chess Master" });
    expect(a).toBe(b);
  });

  it("differs when the payload differs", () => {
    const a = computeRequestHash({ displayName: "Chess Master" });
    const b = computeRequestHash({ displayName: "Chess Grandmaster" });
    expect(a).not.toBe(b);
  });
});
