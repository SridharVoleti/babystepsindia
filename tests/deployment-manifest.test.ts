import { describe, expect, it } from "vitest";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import { assertManifestIdentity, declaresSupportedCadenceCelebration, parseDeploymentManifest,
  releaseSupportsMotivationType, validatesCadenceCelebrationDeclaration, validatesMotivationDeclaration }
  from "@/lib/deployment-manifest/schema";

const validRaw = {
  manifestVersion: 1,
  appKey: "chess-master",
  launchPath: "/launch",
  returnPath: "/return",
  identityPath: "/identity",
  healthPath: "/health",
  minimumSdkVersion: "1.0.0",
};

describe("AR-002 manifest validation", () => {
  // AT-AR-002-06/07: manifest parses cleanly and app key matches registry.
  it("parses a valid manifest and confirms app-key identity match", () => {
    const manifest = parseDeploymentManifest(validRaw);
    expect(manifest.appKey).toBe("chess-master");
    expect(() => assertManifestIdentity(manifest, "chess-master")).not.toThrow();
  });

  // AT-AR-002-07: manifest app key mismatch blocks release.
  it("rejects a manifest whose app key does not match the registry app_key", () => {
    const manifest = parseDeploymentManifest(validRaw);
    expect(() => assertManifestIdentity(manifest, "magical-math")).toThrow(DeploymentPipelineError);
    try {
      assertManifestIdentity(manifest, "magical-math");
    } catch (error) {
      expect((error as DeploymentPipelineError).code).toBe("APP_IDENTITY_MISMATCH");
    }
  });

  it("rejects a manifest missing required fields", () => {
    expect(() => parseDeploymentManifest({ ...validRaw, appKey: undefined })).toThrow(DeploymentPipelineError);
    expect(() => parseDeploymentManifest({ ...validRaw, manifestVersion: undefined })).toThrow(DeploymentPipelineError);
    expect(() => parseDeploymentManifest({ ...validRaw, minimumSdkVersion: "not-a-version" })).toThrow(DeploymentPipelineError);
  });

  // AT-AR-002-08: origin/query/fragment path rejected -> APP_MANIFEST_PATH_INVALID.
  it.each([
    ["https://evil.example.com/launch", "absolute origin"],
    ["launch", "missing leading slash"],
    ["/launch?x=1", "query string"],
    ["/launch#frag", "fragment"],
    ["/../secret", "path traversal"],
    ["/" + "a".repeat(250), "too long"],
  ])("rejects an unsafe launchPath: %s (%s)", (badPath) => {
    try {
      parseDeploymentManifest({ ...validRaw, launchPath: badPath });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentPipelineError);
      expect((error as DeploymentPipelineError).code).toBe("APP_MANIFEST_PATH_INVALID");
    }
  });

  // Business rule 8: no origin, SSO secret, API key or credential permitted in the manifest.
  it.each(["origin", "productionUrl", "launchOrigin", "audience", "secret", "apiKey", "ssoSecret"])(
    "rejects a manifest carrying a forbidden field: %s",
    (forbiddenField) => {
      expect(() =>
        parseDeploymentManifest({ ...validRaw, [forbiddenField]: "should-not-be-here" }),
      ).toThrow(DeploymentPipelineError);
    },
  );

  it("validates the EG-003 app-owned celebration and accessibility declaration", () => {
    const manifest = parseDeploymentManifest({ ...validRaw, weeklyCadenceCelebration: {
      celebrationContextVersion: "1.0", accessibility: { immediateSkip: true, reducedMotion: true,
        keyboardNavigation: true, screenReaderText: true, mobileMinimumTargetCssPixels: 44 },
    } });
    expect(declaresSupportedCadenceCelebration(manifest)).toBe(true);
    expect(validatesCadenceCelebrationDeclaration(manifest)).toBe(true);
    expect(validatesCadenceCelebrationDeclaration(parseDeploymentManifest(validRaw))).toBe(true);
  });

  it("rejects incomplete accessibility declarations and fails unsupported context versions", () => {
    expect(() => parseDeploymentManifest({ ...validRaw, weeklyCadenceCelebration: {
      celebrationContextVersion: "1.0", accessibility: { immediateSkip: true, reducedMotion: true,
        keyboardNavigation: true, screenReaderText: true, mobileMinimumTargetCssPixels: 43 },
    } })).toThrow(DeploymentPipelineError);
    const future = parseDeploymentManifest({ ...validRaw, weeklyCadenceCelebration: {
      celebrationContextVersion: "2.0", accessibility: { immediateSkip: true, reducedMotion: true,
        keyboardNavigation: true, screenReaderText: true, mobileMinimumTargetCssPixels: 48 },
    } });
    expect(validatesCadenceCelebrationDeclaration(future)).toBe(false);
  });

  it("validates the EG-004 release summary declaration by shape only", () => {
    const manifest = parseDeploymentManifest({ ...validRaw, motivation: { motivationContractVersion: "1.0",
      supportedDisplayTypes: ["steps", "label"] } });
    expect(validatesMotivationDeclaration(manifest)).toBe(true);
    expect(releaseSupportsMotivationType(manifest, "steps")).toBe(true);
    expect(releaseSupportsMotivationType(manifest, "percentage")).toBe(false);
  });

  it("rejects invalid EG-004 type declarations and fails unsupported contract versions", () => {
    expect(() => parseDeploymentManifest({ ...validRaw, motivation: { motivationContractVersion: "1.0",
      supportedDisplayTypes: ["steps", "steps"] } })).toThrow(DeploymentPipelineError);
    expect(() => parseDeploymentManifest({ ...validRaw, motivation: { motivationContractVersion: "1.0",
      supportedDisplayTypes: ["gauge"] } })).toThrow(DeploymentPipelineError);
    expect(validatesMotivationDeclaration(parseDeploymentManifest({ ...validRaw, motivation: {
      motivationContractVersion: "2.0", supportedDisplayTypes: ["steps"] } }))).toBe(false);
  });
});
