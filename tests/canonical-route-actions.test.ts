import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { PUBLIC_API_ROUTE, resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";
import { middleware } from "@/middleware";

function routeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(target) : entry.name === "route.ts" ? [target] : [];
  });
}

function pathnameFor(file: string) {
  const relative = path.relative(path.join(process.cwd(), "src/app"), path.dirname(file)).replaceAll("\\", "/");
  return `/${relative.replace(/\[([^\]]+)\]/g, "sample-$1")}`;
}

describe("AU-001 canonical protected API actions", () => {
  it("classifies every exported v1 method and registers every protected action", () => {
    const missing: string[] = [];
    for (const file of routeFiles(path.join(process.cwd(), "src/app/v1"))) {
      const source = fs.readFileSync(file, "utf8");
      const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)/g)].map((match) => match[1]);
      for (const method of methods) {
        const pathname = pathnameFor(file);
        const declaration = resolveApiRouteAuthorization(method, pathname);
        if (!declaration) missing.push(`${method} ${pathname}`);
        else if (declaration !== PUBLIC_API_ROUTE && !(declaration in AUTHORIZATION_ACTIONS)) missing.push(`${method} ${pathname} -> ${declaration}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("fails closed for unknown routes and methods", () => {
    expect(resolveApiRouteAuthorization("POST", "/v1/apps")).toBeUndefined();
    expect(resolveApiRouteAuthorization("GET", "/v1/unregistered-resource")).toBeUndefined();
  });

  it("uses the declaration on every protected request and overwrites caller claims", async () => {
    const request = new NextRequest("https://platform.example/v1/parent/profile", {
      method: "PATCH",
      headers: { "x-babysteps-canonical-action": "admin.app.delete" },
    });
    const response = await middleware(request);
    expect(response.headers.get("x-middleware-request-x-babysteps-canonical-action"))
      .toBe("parent.profile.update");
  });

  it("rejects an undeclared API before its handler runs", async () => {
    const response = await middleware(new NextRequest("https://platform.example/v1/unknown", { method: "GET" }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "AUTHORIZATION_ACTION_UNKNOWN" });
  });
});
