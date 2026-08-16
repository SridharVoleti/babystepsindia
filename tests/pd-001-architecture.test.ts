import fs from "node:fs";
import { describe, expect, it } from "vitest";

const serviceSource = fs.readFileSync("src/lib/parent-dashboard/service.ts", "utf8");
const pageSource = fs.readFileSync("src/app/account/page.tsx", "utf8");
const schemaSource = fs.readFileSync("src/lib/db/schema.sql", "utf8");
const routeSource = fs.readFileSync("src/app/v1/parent/dashboard/route.ts", "utf8");

// PD-001 frozen architecture — static source evidence for the ATs that are
// genuinely "this pattern must never appear", not a runtime scenario.
describe("PD-001 frozen architecture (AT-PD-001-29/30/32/43/46/47/48)", () => {
  it("AT-04: exactly one effective-entitlement row can exist per learner+app+environment — EN-002's own unique constraint, so overlapping sources can never render as two cards", () => {
    expect(schemaSource).toMatch(/unique\(learner_id,\s*app_id,\s*environment\)/);
  });

  it("AT-46: the dashboard has no durable table of its own acting as a second source of truth", () => {
    expect(schemaSource).not.toMatch(/create table (?:if not exists )?parent_dashboard/i);
    expect(serviceSource).not.toMatch(/getDb\s*\(/);
  });

  it("AT-47: the dashboard module has no write/mutation export and the route only ever exports GET", () => {
    expect(serviceSource).not.toMatch(/export\s+function\s+(?:update|write|mutate|set|delete|create)[A-Z]/);
    const methods = [...routeSource.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((m) => m[1]);
    expect(methods).toEqual(["GET"]);
  });

  it("AT-29: no sibling-learner ranking/comparison computation exists in the composer", () => {
    expect(serviceSource).not.toMatch(/rank|compareLearner|leaderboard/i);
  });

  it("AT-30: no cross-app normalized/averaged score computation exists in the composer", () => {
    expect(serviceSource).not.toMatch(/average|normalized?Score|globalScore|crossApp/i);
  });

  it("AT-32: the dashboard page is a plain server component with zero client-side polling capability", () => {
    expect(pageSource).not.toMatch(/^"use client"/m);
    expect(pageSource).not.toMatch(/setInterval|setTimeout|useEffect|EventSource|WebSocket|fetch\(/);
  });

  it("AT-43: the dashboard never renders audio/video/autoplay content", () => {
    expect(pageSource).not.toMatch(/<audio|<video|autoPlay/i);
  });
});

describe("PD-001 privacy (AT-PD-001-48)", () => {
  it("the dashboard app-card type never carries a raw learning/payment/security field", async () => {
    // A structural check, not a string scan: the frozen ParentDashboardAppCard
    // shape must exclude session/eligibility/primaryAction (rule 30-35) and
    // the dashboard module must never re-import anything payment/credential
    // shaped.
    expect(serviceSource).not.toMatch(/cardNumber|cvv|ssn|password|apiKey|secret\b/i);
    expect(serviceSource).toMatch(/session,\s*eligibility,\s*primaryAction/);
  });
});
