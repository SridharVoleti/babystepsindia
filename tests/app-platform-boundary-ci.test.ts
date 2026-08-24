import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  scanApplicationBoundary,
  validateBoundaryAllowlist,
} from "../scripts/check-app-platform-boundary.mjs";

const temporaryDirectories: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "babysteps-app-boundary-"));
  temporaryDirectories.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("AU-001 application/platform CI boundary", () => {
  it("rejects Babysteps database URLs, service-role credentials and clients", () => {
    const root = fixture({
      "apps/chess/server.ts": `
        import { createClient } from "@supabase/supabase-js";
        createClient(process.env.BABYSTEPS_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
      `,
      "apps/math/config.ts": `export const database = process.env.DATABASE_URL;`,
    });

    expect(scanApplicationBoundary(root, [])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "platform_service_credential" }),
        expect.objectContaining({ rule: "direct_database_credential" }),
        expect.objectContaining({ rule: "platform_database_client" }),
      ]),
    );
  });

  it("rejects direct platform tables, functions and auth administration", () => {
    const root = fixture({
      "apps/reader/platform.ts": `
        platform.from("learner_sessions").select();
        platform.rpc("consume_replacement_credit");
        platform.auth.admin.deleteUser(userId);
      `,
    });

    const rules = scanApplicationBoundary(root, []).map((violation) => violation.rule);
    expect(rules).toContain("platform_table_access");
    expect(rules).toContain("platform_database_function");
    expect(rules).toContain("platform_auth_administration");
  });

  it("permits app-owned static curriculum and calls to documented platform APIs", () => {
    const root = fixture({
      "apps/math/content.json": `{"lesson":"addition"}`,
      "apps/math/platform-client.ts": `fetch(platformUrl + "/v1/internal/learner-app-progress")`,
    });
    expect(scanApplicationBoundary(root, [])).toEqual([]);
  });

  it("allows only exact, reviewed, unexpired app-owned infrastructure exceptions", () => {
    const root = fixture({
      "apps/chess/scripts/seed.ts": `process.env.SUPABASE_SERVICE_KEY`,
    });
    const allowlist = [{
      path: "apps/chess/scripts/seed.ts",
      rules: ["generic_service_credential"],
      owner: "ChessMaster",
      reason: "Seeds app-owned curriculum only; cannot access Babysteps infrastructure.",
      expiresOn: "2026-12-31",
    }];
    expect(validateBoundaryAllowlist(root, allowlist, new Date("2026-08-06"))).toEqual([]);
    expect(scanApplicationBoundary(root, allowlist)).toEqual([]);
    expect(validateBoundaryAllowlist(root, [{ ...allowlist[0], path: "apps/**" }], new Date("2026-08-06")))
      .toContainEqual(expect.objectContaining({ code: "ALLOWLIST_WILDCARD" }));
  });

  it("rejects browser-exposed credentials, platform internals and direct network bypasses", () => {
    const root = fixture({
      "apps/math/browser.ts": `const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        fetch("https://platform-project.supabase.co/rest/v1/learners");`,
      "apps/math/server.ts": `import { getDb } from "@/lib/db/client";`,
    });
    expect(scanApplicationBoundary(root, []).map((item) => item.rule)).toEqual(expect.arrayContaining([
      "browser_exposed_platform_credential", "platform_internal_dependency", "direct_platform_network_access",
    ]));
  });
});
