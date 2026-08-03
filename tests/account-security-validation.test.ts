import { describe, expect, it } from "vitest";
import {
  validateNewEmail,
  validateNewPasswordFormat,
  validateDeleteConfirmation,
} from "@/lib/account/security-validation";

describe("validateNewEmail", () => {
  it("normalizes and accepts a different valid email", () => {
    const result = validateNewEmail({ currentEmail: "old@example.com", newEmail: " New@Example.com " });
    expect(result).toEqual({ ok: true, email: "new@example.com" });
  });

  it("rejects an invalid email", () => {
    const result = validateNewEmail({ currentEmail: "old@example.com", newEmail: "not-an-email" });
    expect(result).toMatchObject({ ok: false, code: "EMAIL_INVALID" });
  });

  it("rejects the same email (normalized comparison)", () => {
    const result = validateNewEmail({ currentEmail: "old@example.com", newEmail: "OLD@example.com" });
    expect(result).toMatchObject({ ok: false, code: "EMAIL_UNCHANGED" });
  });
});

describe("validateNewPasswordFormat", () => {
  it("accepts a compliant matching password", () => {
    expect(
      validateNewPasswordFormat({ newPassword: "CorrectHorse2!", confirmPassword: "CorrectHorse2!" }),
    ).toEqual({ ok: true });
  });

  it("rejects a weak password", () => {
    const result = validateNewPasswordFormat({ newPassword: "short", confirmPassword: "short" });
    expect(result).toMatchObject({ ok: false, code: "PASSWORD_INVALID" });
  });

  it("rejects a mismatched confirmation", () => {
    const result = validateNewPasswordFormat({
      newPassword: "CorrectHorse2!",
      confirmPassword: "Different2!",
    });
    expect(result).toMatchObject({ ok: false, code: "PASSWORD_MISMATCH" });
  });
});

describe("validateDeleteConfirmation", () => {
  it("accepts the exact text DELETE", () => {
    expect(validateDeleteConfirmation("DELETE")).toBe(true);
  });

  it("rejects anything else, including different casing", () => {
    expect(validateDeleteConfirmation("delete")).toBe(false);
    expect(validateDeleteConfirmation("Delete")).toBe(false);
    expect(validateDeleteConfirmation(" DELETE ")).toBe(false);
    expect(validateDeleteConfirmation("")).toBe(false);
  });
});
