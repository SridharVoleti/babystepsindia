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
    expect(manifest.authoritative.activeRequirementCount).toBe(67);
    expect(manifest.authoritative.supersededBuildingBlock.id).toBe("BB-17");
    expect(manifest.authoritative.supersededBuildingBlock.legacyIds).toEqual(
      ["DP-001", "DP-002", "DP-003", "DP-004", "DP-005"]);
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
