import { describe, expect, it } from "vitest";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import { assertManifestIdentity, parseDeploymentManifest } from "@/lib/deployment-manifest/schema";

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
});
