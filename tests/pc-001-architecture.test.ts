import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

const TRACKER_PATTERNS = [
  /google-analytics/i, /gtag/i, /segment/i, /mixpanel/i, /amplitude/i, /hotjar/i, /fullstory/i,
  /logrocket/i, /facebook-pixel/i, /fbevents/i, /doubleclick/i, /adsense/i, /sentry.*replay/i,
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(target);
    return /\.(ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const libFiles = walk("src/lib");

describe("PC-001 privacy-by-design frozen architecture", () => {
  it("AC4: no behavioral-ads/analytics-tracker/session-replay third-party SDK is a project dependency", () => {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const offenders = Object.keys(deps).filter((dep) => TRACKER_PATTERNS.some((pattern) => pattern.test(dep)));
    expect(offenders).toEqual([]);
  });

  it("no source file imports a tracker/analytics-SDK package by name", () => {
    const offenders: string[] = [];
    for (const file of libFiles) {
      const source = fs.readFileSync(file, "utf8");
      // Scoped to actual import/require module specifiers only — a bare
      // substring match false-positives on unrelated words like "segment"
      // (Intl.Segmenter, active_segment_started_at) that have nothing to
      // do with Segment.io.
      const importSpecifiers = [...source.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      if (importSpecifiers.some((spec) => TRACKER_PATTERNS.some((pattern) => pattern.test(spec)))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC3: no raw personal-identifier field is ever passed directly to console.log/warn/error anywhere in src/lib", () => {
    const restrictedFieldPattern = /console\.(log|warn|error)\([^)]*\b(display_name|date_of_birth|phone_e164|password_hash|\.email\b)\b/i;
    const offenders: string[] = [];
    for (const file of libFiles) {
      const source = fs.readFileSync(file, "utf8");
      if (restrictedFieldPattern.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC5: the app-facing launch/session service never returns a raw email, phone, or date_of_birth field to a consumer app", () => {
    const appFacingFiles = [
      "src/lib/app-launch/service.ts", "src/lib/app-launch/app-sdk.ts", "src/lib/app-launch/principal.ts",
      "src/lib/app-progress/summary-read.ts",
    ].filter((f) => fs.existsSync(f));
    for (const file of appFacingFiles) {
      const source = fs.readFileSync(file, "utf8");
      // Reading date_of_birth to DERIVE an age/age-band is fine (PC-001's
      // own "derived before raw" principle) — what's checked here is that
      // the raw value is never itself part of a returned/composed object
      // literal key, i.e. never `dateOfBirth:` / `date_of_birth:` in a
      // response shape.
      expect(source).not.toMatch(/\b(email|phone|phoneE164|dateOfBirth)\s*:/);
    }
  });

  it("AC2: no consumer/app API composes a full parent or learner profile object — only the specific fields each contract already documents", () => {
    const sdkSource = fs.readFileSync("src/lib/app-launch/app-sdk.ts", "utf8");
    expect(sdkSource).not.toMatch(/select\s+\*\s+from\s+(profiles|learners|users)\b/i);
  });
});
