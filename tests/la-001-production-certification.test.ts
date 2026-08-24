import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("LA-001 production persistence certification", () => {
  it("routes all launch state, deployment, entitlement, principal, grant and audit persistence through DbClient", () => {
    const launch = read("src/lib/app-launch/service.ts");
    const deployment = read("src/lib/app-launch/deployment.ts");
    const principal = read("src/lib/app-launch/principal.ts");
    const entitlement = read("src/lib/entitlement-access/service.ts");
    const grant = read("src/lib/app-authorization/service.ts");

    expect(launch).toContain('resolveDbClient');
    expect(launch).not.toContain('from "@/lib/db/client"');
    expect(launch).toContain("issueInitialAppGrantWithClient(db");
    expect(launch).toContain("evaluateLaunchAccessFresh(db");
    expect(deployment).toContain("resolveTrustedDeploymentForProduction");
    expect(principal).toContain("verifyAppClientAssertionWithClient");
    expect(entitlement).toContain("evaluateLaunchAccessFresh(db: DbClient");
    expect(grant).toContain("issueInitialAppGrantWithClient(db: DbClient");
  });

  it("keeps consumption, replay protection, provisional grant, receipt and audit in one transaction", () => {
    const launch = read("src/lib/app-launch/service.ts");
    const transactionStart = launch.indexOf("transaction(async (db)", launch.indexOf("export async function exchangeAppLaunch"));
    const transactionBody = launch.slice(transactionStart, launch.indexOf("return result", transactionStart));
    for (const evidence of ["app_client_assertion_replays", "status='exchanged'", "issueInitialAppGrantWithClient(db",
      "app_launch_exchange_receipts", "app_launch_exchanged"]) expect(transactionBody).toContain(evidence);
  });

  it("forces RLS and server-only access on every temporary launch table", () => {
    const migration = read("supabase/migrations/0026_au001_rls_repository_scope.sql");
    const boundaries = read("src/lib/db/access-boundaries.ts");
    for (const table of ["learner_session_launch_state", "app_launch_exchange_receipts", "app_client_assertion_replays"]) {
      expect(migration).toMatch(new RegExp(`alter table ${table} force row level security`, "i"));
      expect(boundaries).toMatch(new RegExp(`${table}: [\"']server_only[\"']`));
    }
  });
});
