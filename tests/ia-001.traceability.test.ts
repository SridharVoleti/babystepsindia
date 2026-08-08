// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function testFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(target);
    return /\.test\.(?:ts|tsx)$/.test(entry.name) && entry.name !== "ia-001.traceability.test.ts"
      ? [target]
      : [];
  });
}

describe("IA-001 acceptance traceability", () => {
  it("maps every approved workbook test ID to executable behavioral evidence", () => {
    const source = testFiles(path.join(process.cwd(), "tests"))
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    const missing = Array.from({ length: 9 }, (_, index) =>
      `AT-IA-001-${String(index + 1).padStart(2, "0")}`,
    ).filter((id) => !source.includes(id));

    expect(missing).toEqual([]);
  });
});
