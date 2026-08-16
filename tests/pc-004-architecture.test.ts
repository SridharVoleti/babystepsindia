import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_RETENTION_TABLES } from "@/lib/data-retention/service";

const retentionSource = fs.readFileSync("src/lib/data-retention/service.ts", "utf8");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : /route\.ts$/.test(entry.name) ? [target] : [];
  });
}

describe("PC-004 frozen architecture", () => {
  it("no financial/security/audit legal-retention table is ever written to by the erasure module", () => {
    for (const table of LEGAL_RETENTION_TABLES) {
      expect(retentionSource).not.toMatch(new RegExp(`(update|delete from|insert into)\\s+${table}\\b`, "i"));
    }
  });

  it("no user/API route calls erasePersonalAndLearningData or replayDeletionObligations directly — no direct hard-delete endpoint", () => {
    const offenders: string[] = [];
    for (const file of walk("src/app/v1")) {
      const source = fs.readFileSync(file, "utf8");
      if (/erasePersonalAndLearningData|replayDeletionObligations/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the erasure module never imports a Supabase/provider client of its own — it uses the same getDb() as everything else, no second storage path", () => {
    expect(retentionSource).not.toMatch(/supabase|createClient\(/i);
  });

  it("only the existing journey-retention sweep triggers erasure — no second scheduled job/timer is defined in this module", () => {
    expect(retentionSource).not.toMatch(/setInterval|setTimeout|cron/i);
  });
});
