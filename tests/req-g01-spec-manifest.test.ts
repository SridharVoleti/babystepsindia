import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// REQ-G01: Codex/audits must work from one pinned authoritative requirements
// baseline. This fails closed if the authoritative workbook is missing or
// silently replaced with different content (a changed hash means someone
// edited/regenerated the file without updating the pinned manifest).
const manifestPath = path.join(process.cwd(), "Requirements", "SPEC_MANIFEST.json");

describe("REQ-G01 authoritative spec manifest", () => {
  it("the manifest file exists and is well-formed", () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest.authoritative.file).toBe("Babysteps_Platform_Requirements_FINAL_v65.xlsx");
    expect(manifest.authoritative.activeRequirementCount).toBe(66);
    expect(manifest.authoritative.deferredRequirementCount).toBe(8);
    expect(manifest.authoritative.confirmedDeferrals["LP-003"]).toEqual({
      priority: "Should Have",
      approvalStatus: "Deferred",
      codexReady: "No",
      decision: "DEC-SCOPE-005",
      scope: "outside Version 1",
      authorizationModel: "owner_parent_id only",
    });
    expect(manifest.authoritative.supersededBuildingBlock.id).toBe("BB-17");
    expect(manifest.authoritative.supersededBuildingBlock.legacyIds).toEqual(
      ["DP-001", "DP-002", "DP-003", "DP-004", "DP-005"]);
  });

  it("keeps LP-003 out of the active V1 baseline unless a new frozen decision supersedes it", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const lp003 = manifest.authoritative.confirmedDeferrals["LP-003"];

    expect(lp003.approvalStatus).toBe("Deferred");
    expect(lp003.codexReady).toBe("No");
    expect(lp003.scope).toBe("outside Version 1");
    expect(lp003.authorizationModel).toBe("owner_parent_id only");
  });

  it("does not expose a Version 1 guardian-sharing API surface", () => {
    const forbiddenRoutes = [
      path.join(process.cwd(), "src", "app", "v1", "parent", "guardian-invitations"),
      path.join(process.cwd(), "src", "app", "v1", "parent", "guardians"),
      path.join(process.cwd(), "src", "app", "v1", "parent", "households"),
    ];

    for (const route of forbiddenRoutes) {
      expect(fs.existsSync(route), `LP-003 remains deferred; unexpected route: ${route}`).toBe(false);
    }
  });

  it("the authoritative FINAL v65 workbook is present in the repository", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const filePath = path.join(process.cwd(), "Requirements", manifest.authoritative.file);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("the authoritative workbook's content matches the pinned hash — fails if silently replaced", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const filePath = path.join(process.cwd(), "Requirements", manifest.authoritative.file);
    const actualHash = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    expect(actualHash).toBe(manifest.authoritative.sha256);
  });

  it("every historical workbook listed in the manifest is still present, clearly superseded, not deleted", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const file of manifest.historical as string[]) {
      expect(fs.existsSync(path.join(process.cwd(), "Requirements", file))).toBe(true);
    }
  });
});
