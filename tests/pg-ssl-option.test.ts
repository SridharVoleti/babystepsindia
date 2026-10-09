import { describe, expect, it } from "vitest";
import { sslOptionFor } from "@/lib/db-client/postgres-adapter";

// Local/CI verification against a disposable plain-TCP Postgres needs an explicit opt-out; production can never disable TLS.
describe("postgres adapter TLS option", () => {
  it("defaults to TLS without certificate-chain pinning (Supabase pooler guidance)", () => {
    expect(sslOptionFor({})).toEqual({ rejectUnauthorized: false });
  });
  it("can be disabled explicitly outside production", () => {
    expect(sslOptionFor({ SUPABASE_DB_SSL: "disable", NODE_ENV: "test" })).toBe(false);
    expect(sslOptionFor({ SUPABASE_DB_SSL: "disable", NODE_ENV: "development" })).toBe(false);
  });
  it("can never be disabled in production, whatever the flag", () => {
    expect(sslOptionFor({ SUPABASE_DB_SSL: "disable", NODE_ENV: "production" })).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor({ SUPABASE_DB_SSL: "disable", VERCEL_ENV: "production", NODE_ENV: "test" })).toEqual({ rejectUnauthorized: false });
  });
});
