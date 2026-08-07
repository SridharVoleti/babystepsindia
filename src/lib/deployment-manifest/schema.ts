import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

// AR-002 business rule 7-10: the versioned repository manifest carries
// identity + relative routing paths + minimum SDK version only — no
// origin, audience, or credential of any kind (business rule 8).
export type DeploymentManifest = {
  manifestVersion: number;
  appKey: string;
  launchPath: string;
  returnPath: string;
  identityPath: string;
  healthPath: string;
  minimumSdkVersion: string;
};

const RELATIVE_PATH_PATTERN = /^\/[A-Za-z0-9\-_/]{0,199}$/;
const SDK_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// Fields that would let the manifest smuggle in exactly what business rule
// 8 forbids: an origin, an SSO audience, or a secret/credential of any kind.
const FORBIDDEN_MANIFEST_FIELDS = [
  "origin",
  "productionUrl",
  "launchOrigin",
  "audience",
  "secret",
  "apiKey",
  "ssoSecret",
  "credential",
];

function validateRelativePath(value: unknown): string {
  if (typeof value !== "string" || !RELATIVE_PATH_PATTERN.test(value)) {
    throw new DeploymentPipelineError("APP_MANIFEST_PATH_INVALID");
  }
  // The character class already excludes '?' and '#'; still reject '..'
  // segments and scheme markers explicitly so intent stays legible.
  if (value.includes("..") || value.includes("://")) {
    throw new DeploymentPipelineError("APP_MANIFEST_PATH_INVALID");
  }
  return value;
}

export function parseDeploymentManifest(raw: unknown): DeploymentManifest {
  if (!raw || typeof raw !== "object") throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
  const manifest = raw as Record<string, unknown>;

  for (const forbidden of FORBIDDEN_MANIFEST_FIELDS) {
    if (forbidden in manifest) throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
  }
  if (typeof manifest.manifestVersion !== "number" || !Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) {
    throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
  }
  if (typeof manifest.appKey !== "string" || manifest.appKey.length < 2 || manifest.appKey.length > 50) {
    throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
  }
  if (typeof manifest.minimumSdkVersion !== "string" || !SDK_VERSION_PATTERN.test(manifest.minimumSdkVersion)) {
    throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
  }

  return {
    manifestVersion: manifest.manifestVersion,
    appKey: manifest.appKey,
    launchPath: validateRelativePath(manifest.launchPath),
    returnPath: validateRelativePath(manifest.returnPath),
    identityPath: validateRelativePath(manifest.identityPath),
    healthPath: validateRelativePath(manifest.healthPath),
    minimumSdkVersion: manifest.minimumSdkVersion,
  };
}

// Business rule 9: manifest appKey must exactly match the immutable
// registry app_key.
export function assertManifestIdentity(manifest: DeploymentManifest, registryAppKey: string): void {
  if (manifest.appKey !== registryAppKey) {
    throw new DeploymentPipelineError("APP_IDENTITY_MISMATCH");
  }
}
