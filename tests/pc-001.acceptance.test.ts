import { describe, expect, it } from "vitest";
import {
  PERSONAL_DATA_CATALOG,
  type PersonalDataCatalogEntry,
} from "@/lib/privacy-governance/catalog";
import {
  PrivacyPolicyError,
  authorizeDevicePermission,
  authorizePersonalDataUse,
  isPersonalOrPseudonymous,
  validatePersonalDataCatalog,
} from "@/lib/privacy-governance/policy";

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("expected privacy policy rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(PrivacyPolicyError);
    expect((error as PrivacyPolicyError).code).toBe(code);
  }
}

describe("PC-001 — Privacy by Design & Data Minimization", () => {
  it("validates the version-controlled Personal Data Catalog", () => {
    expect(validatePersonalDataCatalog()).toBe(true);
  });

  it("fails closed for an unregistered personal-data element", () => {
    expectCode(() => authorizePersonalDataUse({
      key: "learner.favorite_colour",
      purpose: "learning_personalization",
      consumer: "app_launch_service",
      surface: "learning_app",
    }), "DATA_USE_NOT_CATALOGED");
  });

  it("rejects incomplete catalog entries", () => {
    const invalid = { ...PERSONAL_DATA_CATALOG[0], purpose: "" } as unknown as PersonalDataCatalogEntry;
    expectCode(() => validatePersonalDataCatalog([invalid]), "CATALOG_ENTRY_INCOMPLETE");
  });

  it("prohibits learner contact data", () => {
    const invalid = {
      ...PERSONAL_DATA_CATALOG[0],
      key: "learner.email",
      subject: "learner",
      authoritativeStore: "learners.email",
    } as PersonalDataCatalogEntry;
    expectCode(() => validatePersonalDataCatalog([invalid]), "LEARNER_CONTACT_DATA_PROHIBITED");
  });

  it("keeps raw learner DOB out of learning apps, logs, telemetry and analytics", () => {
    for (const surface of ["learning_app", "log", "telemetry", "analytics"] as const) {
      expectCode(() => authorizePersonalDataUse({
        key: "learner.date_of_birth",
        purpose: "learner_profile",
        consumer: surface === "analytics" ? "analytics_service" : "app_launch_service",
        surface,
      }), "SURFACE_NOT_AUTHORIZED");
    }
  });

  it("permits only derived learner age for approved app personalization", () => {
    const entry = authorizePersonalDataUse({
      key: "learner.age_derived",
      purpose: "learning_personalization",
      consumer: "app_launch_service",
      surface: "learning_app",
    });
    expect(entry.raw).toBe(false);
    expect(entry.classification).toBe("derived");
  });

  it("permits analytics age band but denies raw DOB in analytics", () => {
    expect(authorizePersonalDataUse({
      key: "learner.analytics_age_band",
      purpose: "anonymous_operational_analytics",
      consumer: "analytics_service",
      surface: "analytics",
    }).analytics).toBe("permanent_anonymous");
    expectCode(() => authorizePersonalDataUse({
      key: "learner.date_of_birth",
      purpose: "learner_profile",
      consumer: "analytics_service",
      surface: "analytics",
    }), "SURFACE_NOT_AUTHORIZED");
  });

  it("denies unregistered logging and telemetry use", () => {
    for (const surface of ["log", "telemetry"] as const) {
      expectCode(() => authorizePersonalDataUse({
        key: "parent.email",
        purpose: "parent_identity",
        consumer: "identity_service",
        surface,
      }), "SURFACE_NOT_AUTHORIZED");
    }
  });

  it("denies every device permission unless explicitly cataloged", () => {
    expectCode(() => authorizeDevicePermission("camera"), "DEVICE_PERMISSION_NOT_AUTHORIZED");
    expectCode(() => authorizeDevicePermission("microphone"), "DEVICE_PERMISSION_NOT_AUTHORIZED");
    expectCode(() => authorizeDevicePermission("location"), "DEVICE_PERMISSION_NOT_AUTHORIZED");
  });

  it.each(["advertising", "advertising_profile", "session_replay", "learner_surveillance", "behavioral_tracking"])(
    "always rejects prohibited purpose %s",
    (purpose) => {
      expectCode(() => authorizePersonalDataUse({
        key: "learner.age_derived",
        purpose,
        consumer: "app_launch_service",
        surface: "learning_app",
      }), "PURPOSE_PROHIBITED");
    },
  );

  it("enforces purpose-specific least privilege", () => {
    expectCode(() => authorizePersonalDataUse({
      key: "parent.email",
      purpose: "parent_identity",
      consumer: "app_launch_service",
      surface: "server",
    }), "CONSUMER_NOT_AUTHORIZED");
    expectCode(() => authorizePersonalDataUse({
      key: "learner.age_derived",
      purpose: "parent_identity",
      consumer: "app_launch_service",
      surface: "learning_app",
    }), "PURPOSE_NOT_AUTHORIZED");
  });

  it("denies administrator access unless the catalog explicitly permits it", () => {
    expectCode(() => authorizePersonalDataUse({
      key: "learner.age_derived",
      purpose: "learning_personalization",
      consumer: "administrator",
      surface: "administrator",
    }), "CONSUMER_NOT_AUTHORIZED");
  });

  it("rejects a second raw authority for the same personal-data element", () => {
    const first = PERSONAL_DATA_CATALOG[0] as PersonalDataCatalogEntry;
    const duplicate = { ...first, authoritativeStore: "billing_notifications.recipient_email" };
    expectCode(() => validatePersonalDataCatalog([first, duplicate]), "CATALOG_DUPLICATE_KEY");
  });

  it("classifies notification recipient linkage as personal/pseudonymous evidence", () => {
    expect(isPersonalOrPseudonymous("billing.notification_subscription_reference")).toBe(true);
  });
});
