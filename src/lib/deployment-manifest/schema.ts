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
  weeklyCadenceCelebration?: {
    celebrationContextVersion: string;
    accessibility: {
      immediateSkip: true;
      reducedMotion: true;
      keyboardNavigation: true;
      screenReaderText: true;
      mobileMinimumTargetCssPixels: number;
    };
  };
  motivation?: {
    motivationContractVersion: string;
    supportedDisplayTypes: import("@/lib/progress-motivation/contracts").MotivationDisplayType[];
  };
  journey?: {
    journeyContractVersion: string;
    lessonDisplayMetadata: boolean;
    milestoneDisplayMetadata: boolean;
    allowedIconAssetKeys: string[];
  };
};

export const CADENCE_CELEBRATION_CONTEXT_VERSION = "1.0" as const;
export const MOTIVATION_CONTRACT_VERSION = "1.0" as const;

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

  let weeklyCadenceCelebration: DeploymentManifest["weeklyCadenceCelebration"];
  if (manifest.weeklyCadenceCelebration !== undefined) {
    if (!manifest.weeklyCadenceCelebration || Array.isArray(manifest.weeklyCadenceCelebration) ||
        typeof manifest.weeklyCadenceCelebration !== "object") {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    const declaration = manifest.weeklyCadenceCelebration as Record<string, unknown>;
    if (Object.keys(declaration).some((key) => !["celebrationContextVersion", "accessibility"].includes(key)) ||
        typeof declaration.celebrationContextVersion !== "string" ||
        !CONTRACT_VERSION_PATTERN.test(declaration.celebrationContextVersion) ||
        !declaration.accessibility || Array.isArray(declaration.accessibility) ||
        typeof declaration.accessibility !== "object") {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    const accessibility = declaration.accessibility as Record<string, unknown>;
    const accessibilityKeys = ["immediateSkip", "reducedMotion", "keyboardNavigation", "screenReaderText",
      "mobileMinimumTargetCssPixels"];
    if (Object.keys(accessibility).some((key) => !accessibilityKeys.includes(key)) ||
        accessibility.immediateSkip !== true || accessibility.reducedMotion !== true ||
        accessibility.keyboardNavigation !== true || accessibility.screenReaderText !== true ||
        !Number.isInteger(accessibility.mobileMinimumTargetCssPixels) ||
        (accessibility.mobileMinimumTargetCssPixels as number) < 44) {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    weeklyCadenceCelebration = {
      celebrationContextVersion: declaration.celebrationContextVersion,
      accessibility: {
        immediateSkip: true,
        reducedMotion: true,
        keyboardNavigation: true,
        screenReaderText: true,
        mobileMinimumTargetCssPixels: accessibility.mobileMinimumTargetCssPixels as number,
      },
    };
  }

  let motivation: DeploymentManifest["motivation"];
  if (manifest.motivation !== undefined) {
    if (!manifest.motivation || Array.isArray(manifest.motivation) || typeof manifest.motivation !== "object") {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    const declaration = manifest.motivation as Record<string, unknown>;
    const supported = ["steps", "percentage", "label", "none"];
    if (Object.keys(declaration).some((key) => !["motivationContractVersion", "supportedDisplayTypes"].includes(key)) ||
        typeof declaration.motivationContractVersion !== "string" ||
        !CONTRACT_VERSION_PATTERN.test(declaration.motivationContractVersion) ||
        !Array.isArray(declaration.supportedDisplayTypes) || declaration.supportedDisplayTypes.length < 1 ||
        declaration.supportedDisplayTypes.length > supported.length ||
        declaration.supportedDisplayTypes.some((type) => typeof type !== "string" || !supported.includes(type)) ||
        new Set(declaration.supportedDisplayTypes).size !== declaration.supportedDisplayTypes.length) {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    motivation = { motivationContractVersion: declaration.motivationContractVersion,
      supportedDisplayTypes: [...new Set(declaration.supportedDisplayTypes)] as NonNullable<DeploymentManifest["motivation"]>["supportedDisplayTypes"] };
  }

  let journey: DeploymentManifest["journey"];
  if (manifest.journey !== undefined) {
    if (!manifest.journey || Array.isArray(manifest.journey) || typeof manifest.journey !== "object") {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    const declaration = manifest.journey as Record<string, unknown>;
    const keys = ["journeyContractVersion", "lessonDisplayMetadata", "milestoneDisplayMetadata",
      "allowedIconAssetKeys"];
    if (Object.keys(declaration).some((key) => !keys.includes(key)) ||
        typeof declaration.journeyContractVersion !== "string" ||
        !CONTRACT_VERSION_PATTERN.test(declaration.journeyContractVersion) ||
        typeof declaration.lessonDisplayMetadata !== "boolean" ||
        typeof declaration.milestoneDisplayMetadata !== "boolean" ||
        !Array.isArray(declaration.allowedIconAssetKeys) || declaration.allowedIconAssetKeys.length > 100 ||
        declaration.allowedIconAssetKeys.some((key) => typeof key !== "string" || !ASSET_KEY_PATTERN.test(key))) {
      throw new DeploymentPipelineError("APP_MANIFEST_INVALID");
    }
    journey = { journeyContractVersion: declaration.journeyContractVersion,
      lessonDisplayMetadata: declaration.lessonDisplayMetadata,
      milestoneDisplayMetadata: declaration.milestoneDisplayMetadata,
      allowedIconAssetKeys: [...new Set(declaration.allowedIconAssetKeys as string[])] };
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
    ...(weeklyCadenceCelebration ? { weeklyCadenceCelebration } : {}),
    ...(motivation ? { motivation } : {}),
    ...(journey ? { journey } : {}),
  };
}

export function declaresSupportedCadenceCelebration(manifest: DeploymentManifest) {
  return manifest.weeklyCadenceCelebration?.celebrationContextVersion === CADENCE_CELEBRATION_CONTEXT_VERSION;
}

export function validatesCadenceCelebrationDeclaration(manifest: DeploymentManifest) {
  return manifest.weeklyCadenceCelebration === undefined || declaresSupportedCadenceCelebration(manifest);
}

export function validatesMotivationDeclaration(manifest: DeploymentManifest) {
  return manifest.motivation === undefined || manifest.motivation.motivationContractVersion === MOTIVATION_CONTRACT_VERSION;
}

export function releaseSupportsMotivationType(manifest: DeploymentManifest,
  displayType: import("@/lib/progress-motivation/contracts").MotivationDisplayType) {
  return manifest.motivation?.motivationContractVersion === MOTIVATION_CONTRACT_VERSION &&
    manifest.motivation.supportedDisplayTypes.includes(displayType);
}

// Business rule 9: manifest appKey must exactly match the immutable
// registry app_key.
export function assertManifestIdentity(manifest: DeploymentManifest, registryAppKey: string): void {
  if (manifest.appKey !== registryAppKey) {
    throw new DeploymentPipelineError("APP_IDENTITY_MISMATCH");
  }
}
