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
  achievement?: {
    contractVersion: string;
    modelVersion: string;
    allowedBadgeAssetKeys: string[];
  };
};

const RELATIVE_PATH_PATTERN = /^\/[A-Za-z0-9\-_/]{0,199}$/;
const SDK_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const CONTRACT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASSET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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

  let achievement: DeploymentManifest["achievement"];
  if (manifest.achievement !== undefined) {
    if (!manifest.achievement || Array.isArray(manifest.achievement) || typeof manifest.achievement !== "object") {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    const declaration = manifest.achievement as Record<string, unknown>;
    if (Object.keys(declaration).some((key) => !["contractVersion", "modelVersion", "allowedBadgeAssetKeys"].includes(key)) ||
        typeof declaration.contractVersion !== "string" || !CONTRACT_VERSION_PATTERN.test(declaration.contractVersion) ||
        typeof declaration.modelVersion !== "string" || !CONTRACT_VERSION_PATTERN.test(declaration.modelVersion) ||
        !Array.isArray(declaration.allowedBadgeAssetKeys) || declaration.allowedBadgeAssetKeys.length > 100 ||
        declaration.allowedBadgeAssetKeys.some((key) => typeof key !== "string" || !ASSET_KEY_PATTERN.test(key))) {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    achievement = { contractVersion: declaration.contractVersion, modelVersion: declaration.modelVersion,
      allowedBadgeAssetKeys: [...new Set(declaration.allowedBadgeAssetKeys as string[])] };
  }

  return {
    manifestVersion: manifest.manifestVersion,
    appKey: manifest.appKey,
    launchPath: validateRelativePath(manifest.launchPath),
    returnPath: validateRelativePath(manifest.returnPath),
    identityPath: validateRelativePath(manifest.identityPath),
    healthPath: validateRelativePath(manifest.healthPath),
    minimumSdkVersion: manifest.minimumSdkVersion,
    ...(achievement ? { achievement } : {}),
  };
}

// Business rule 9: manifest appKey must exactly match the immutable
// registry app_key.
export function assertManifestIdentity(manifest: DeploymentManifest, registryAppKey: string): void {
  if (manifest.appKey !== registryAppKey) {
    throw new DeploymentPipelineError("APP_IDENTITY_MISMATCH");
  }
}
