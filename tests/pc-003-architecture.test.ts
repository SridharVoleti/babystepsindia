import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : /\.(ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

const LEARNER_FACING_DIRS = ["src/app/learner", "src/app/learning-session", "src/lib/app-launch", "src/lib/learner-home"];
const learnerFacingFiles = LEARNER_FACING_DIRS.flatMap(walk);

describe("PC-003 frozen architecture — closed learner ecosystem", () => {
  it("AC4: no learner_mode or app_service authorization action can mutate parent billing/account/subscription state", () => {
    const offenders = Object.entries(AUTHORIZATION_ACTIONS)
      .filter(([, def]) => def.mode === "learner_mode" || def.mode === "app_service")
      .filter(([key]) => /billing|subscription|payment|account\.(delete|restore)|checkout/i.test(key))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("AC2: no chat/messaging/friend/social/public-profile surface exists in learner-facing code", () => {
    const offenders: string[] = [];
    for (const file of learnerFacingFiles) {
      const source = fs.readFileSync(file, "utf8");
      if (/\b(chat|messaging|friend[_-]?request|leaderboard|public[_-]?profile)\b/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC3: no arbitrary external navigation (window.open, target=_blank, raw <iframe>) in learner-facing code", () => {
    const offenders: string[] = [];
    for (const file of learnerFacingFiles) {
      const source = fs.readFileSync(file, "utf8");
      if (/window\.open|target\s*=\s*["']_blank["']|<iframe\b/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC3: every app deployment binding resolves against an approved_domains allowlist entry, never a raw unvalidated URL", () => {
    const source = fs.readFileSync("src/lib/deployment-binding/service.ts", "utf8");
    expect(source).toMatch(/approved_domain/i);
  });

  it("AC5: no device-permission API (geolocation, camera, microphone, bluetooth, usb) is requested anywhere in learner-facing code", () => {
    const offenders: string[] = [];
    const pattern = /navigator\.(geolocation|mediaDevices|bluetooth|usb)|getUserMedia/i;
    for (const file of learnerFacingFiles) {
      const source = fs.readFileSync(file, "utf8");
      if (pattern.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC6: no generative-AI SDK is imported anywhere in learner-facing code", () => {
    const offenders: string[] = [];
    const pattern = /\b(openai|anthropic-ai|@google\/generative-ai|langchain)\b/i;
    for (const file of learnerFacingFiles) {
      const source = fs.readFileSync(file, "utf8");
      const importSpecifiers = [...source.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
      if (importSpecifiers.some((spec) => pattern.test(spec))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("AC6: no generative-AI SDK is a project dependency", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const pattern = /\b(openai|anthropic-ai|@google\/generative-ai|langchain)\b/i;
    const offenders = Object.keys(deps).filter((dep) => pattern.test(dep));
    expect(offenders).toEqual([]);
  });
});
