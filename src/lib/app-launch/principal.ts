import { createSecretKey } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { getDb } from "@/lib/db/client";
import { AppLaunchError } from "@/lib/app-launch/errors";

export type AppPrincipal = {
  id: string; app_id: string; environment: string; deployment_id: string; client_id: string;
  key_ref: string; status: string; valid_from: string; valid_until: string; version: number;
};

function requireSecret(value: string | undefined, name: string) {
  if (!value || value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return createSecretKey(Buffer.from(value, "utf8"));
}

export async function createAppClientAssertion(input: {
  clientId: string; appId: string; environment: string; deploymentId: string; audience: string;
  jti: string; now: Date; secret: string;
}) {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  return new SignJWT({ app_id: input.appId, environment: input.environment, deployment_id: input.deploymentId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuer(input.clientId).setSubject(input.clientId)
    .setAudience(input.audience).setJti(input.jti).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 60)
    .sign(requireSecret(input.secret, "app service secret"));
}

export async function verifyAppClientAssertion(assertion: string, now: Date,
  resolveSecret: (keyRef: string) => string | undefined, audience: string) {
  let unverified: { iss?: string };
  try { unverified = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString()); }
  catch { throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED"); }
  if (!unverified.iss) throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  const principal = getDb().prepare("select * from app_service_principals where client_id=?")
    .get(unverified.iss) as AppPrincipal | undefined;
  if (!principal || principal.status !== "active" || now < new Date(principal.valid_from) || now >= new Date(principal.valid_until))
    throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  try {
    const verified = await jwtVerify(assertion, requireSecret(resolveSecret(principal.key_ref), "app service secret"), {
      issuer: principal.client_id, subject: principal.client_id, audience,
      clockTolerance: 0, currentDate: now, algorithms: ["HS256"],
    });
    const claims = verified.payload;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!claims.jti || !claims.iat || Number(claims.iat) > nowSeconds ||
      Number(claims.exp) - Number(claims.iat) > 60 || claims.app_id !== principal.app_id ||
      claims.environment !== principal.environment || claims.deployment_id !== principal.deployment_id)
      throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
    return { principal, jti: claims.jti, expiresAt: new Date(Number(claims.exp) * 1000).toISOString() };
  } catch (error) {
    if (error instanceof AppLaunchError) throw error;
    throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  }
}
