import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROCESSOR_REGISTER, ProcessorNotRegisteredError, UnapprovedProcessorFieldError, assertProcessorFieldsApproved,
} from "@/lib/privacy/processor-register";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(target) : /\.ts$/.test(entry.name) ? [target] : [];
  });
}

// Extracts every `fieldName:` / `fieldName?:` identifier from a block of
// TS type-literal source — the same "re-derive from live source, fail
// closed on drift" technique PC-001's Data Catalog uses against
// schema.sql, applied here to TS type definitions instead of SQL DDL.
// Scoped per-type-name deliberately, not file-wide: a whole-file scan
// also picks up RESULT/return-type fields (what the processor sends
// BACK), which aren't data this platform transmits and shouldn't be
// held to the same "approved outbound field" allowlist.
function extractFieldNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\??:\s/g)) names.add(match[1]);
  return names;
}

function extractNamedTypeFields(source: string, typeName: string): Set<string> {
  const block = source.match(new RegExp(`export type ${typeName} = \\{([^}]*)\\}`))?.[1] ?? "";
  return extractFieldNames(block);
}

const billingAdapterSource = fs.readFileSync("src/lib/billing/provider-adapter.ts", "utf8");
const deploymentTypesSource = fs.readFileSync("src/lib/deployment-provider/types.ts", "utf8");
const emailAdapterSource = fs.readFileSync("src/lib/notifications/provider-adapter.ts", "utf8");

describe("PC-005 Third-Party Processor Register — mechanically self-verifying", () => {
  it("AC3: every registered processor links processor -> purpose -> frozen requirement", () => {
    for (const entry of Object.values(PROCESSOR_REGISTER)) {
      expect(entry.purpose.length).toBeGreaterThan(0);
      expect(entry.requirementId).toMatch(/^[A-Z]{2,3}-\d{3}$/);
    }
  });

  it("payment_checkout's approved fields are a superset of every field ProviderCheckoutInput's type actually declares", () => {
    const inputBlock = billingAdapterSource.match(/export type ProviderCheckoutInput = \{([^}]*)\}/)?.[1] ?? "";
    const liveFields = extractFieldNames(inputBlock);
    const missing = [...liveFields].filter((field) => !PROCESSOR_REGISTER.payment_checkout.approvedDataFields.includes(field));
    expect(missing).toEqual([]);
  });

  it("deployment_hosting's approved fields are a superset of every field the live ProviderDeployInput/ProviderPromoteInput types declare", () => {
    const liveFields = new Set([
      ...extractNamedTypeFields(deploymentTypesSource, "ProviderDeployInput"),
      ...extractNamedTypeFields(deploymentTypesSource, "ProviderPromoteInput"),
    ]);
    // The two inline (unnamed) input shapes on verifyProject/checkHealth
    // are checked directly against the live interface body below instead
    // of by type name, since they aren't extracted `export type` aliases.
    const interfaceBody = deploymentTypesSource.match(/export interface DeploymentProvider \{([\s\S]*)\}\n?$/)?.[1] ?? "";
    const verifyInput = interfaceBody.match(/verifyProject\(input:\s*\{([^}]*)\}/)?.[1] ?? "";
    const healthInput = interfaceBody.match(/checkHealth\(input:\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const field of extractFieldNames(verifyInput)) liveFields.add(field);
    for (const field of extractFieldNames(healthInput)) liveFields.add(field);
    const missing = [...liveFields].filter((field) => !PROCESSOR_REGISTER.deployment_hosting.approvedDataFields.includes(field));
    expect(missing).toEqual([]);
  });

  it("transactional_email's approved fields are a superset of every field the live send() input parameter declares", () => {
    const sendInput = emailAdapterSource.match(/send\(input:\s*\{([^}]*)\}\)/)?.[1] ?? "";
    const liveFields = extractFieldNames(sendInput);
    expect(liveFields.size).toBeGreaterThan(0);
    const missing = [...liveFields].filter((field) => !PROCESSOR_REGISTER.transactional_email.approvedDataFields.includes(field));
    expect(missing).toEqual([]);
  });

  it("no processor input type declares a raw personal identifier (email/phone/displayName/dateOfBirth)", () => {
    for (const source of [billingAdapterSource, deploymentTypesSource, emailAdapterSource]) {
      const fields = extractFieldNames(source);
      for (const field of fields) {
        expect(field.toLowerCase()).not.toMatch(/^(email|phone|displayname|dateofbirth)$/);
      }
    }
    // 'to' on the email provider is the one deliberate, necessary exception
    // (you cannot deliver email without a destination address) — confirmed
    // present and explicitly approved, not silently allowed by omission.
    expect(PROCESSOR_REGISTER.transactional_email.approvedDataFields).toContain("to");
  });

  it("AC1/AC2: assertProcessorFieldsApproved fails closed for an unregistered processor", () => {
    expect(() => assertProcessorFieldsApproved("unknown_processor", ["anything"])).toThrow(ProcessorNotRegisteredError);
  });

  it("AC2: assertProcessorFieldsApproved fails closed for a non-allowlisted field on a registered processor", () => {
    expect(() => assertProcessorFieldsApproved("payment_checkout", ["checkoutIntentId", "learnerEmail"]))
      .toThrow(UnapprovedProcessorFieldError);
  });

  it("AC2: assertProcessorFieldsApproved passes for an exact allowlisted field set", () => {
    expect(() => assertProcessorFieldsApproved("payment_checkout", ["checkoutIntentId", "purchaserParentId"]))
      .not.toThrow();
  });

  it("AC5: no independent ads/profiling/sale/marketing/model-training integration exists (reuses PC-001's confirmed-clean dependency check)", () => {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const pattern = /google-analytics|segment|mixpanel|amplitude|hotjar|fullstory|logrocket|facebook-pixel|doubleclick|adsense/i;
    expect(Object.keys(deps).filter((dep) => pattern.test(dep))).toEqual([]);
  });

  it("no ad-hoc raw fetch() call to an external host exists outside the three registered adapter modules", () => {
    const registeredFiles = new Set([
      "src\\lib\\billing\\provider-adapter.ts", "src\\lib\\deployment-provider\\types.ts",
      "src\\lib\\notifications\\provider-adapter.ts",
    ]);
    const offenders: string[] = [];
    for (const file of walk("src/lib")) {
      if (registeredFiles.has(file) || file.includes("deployment-provider")) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/fetch\(\s*["']https?:\/\//.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
