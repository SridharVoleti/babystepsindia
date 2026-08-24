import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { DbClient } from "@/lib/db-client/types";
import { AppLaunchError } from "@/lib/app-launch/errors";

export type AppPrincipal = {
  id: string; app_id: string; environment: string; deployment_id: string; client_id: string;
  key_ref: string; public_key: string; status: string; valid_from: string; valid_until: string; version: number;
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function pem(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value.replaceAll("\\n", "\n");
}

// AU-004: the app backend proves its identity with an Ed25519 signature over
// its own private key — the platform never holds or resolves a shared
// secret to verify it, only the principal's public key (see
// verifyAppClientAssertion below).
export function createAppClientAssertion(input: {
  clientId: string; appId: string; environment: string; deploymentId: string; audience: string;
  jti: string; now: Date; privateKeyPem: string;
}) {
  const issuedAt = Math.floor(input.now.getTime() / 1000);
  const header = encode({ alg: "EdDSA", typ: "JWT" });
  const payload = encode({ iss: input.clientId, sub: input.clientId, aud: input.audience, jti: input.jti,
    iat: issuedAt, exp: issuedAt + 60, app_id: input.appId, environment: input.environment,
    deployment_id: input.deploymentId });
  const unsigned = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(unsigned), createPrivateKey(pem(input.privateKeyPem, "app service private key")))
    .toString("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyAppClientAssertion(assertion: string, now: Date, audience: string) {
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  let header: { alg?: string; typ?: string }; let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch { throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED"); }
  if (typeof claims.iss !== "string") throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  const principal = getDb().prepare("select * from app_service_principals where client_id=?")
    .get(claims.iss) as AppPrincipal | undefined;
  if (!principal || principal.status !== "active" || !principal.public_key ||
      now < new Date(principal.valid_from) || now >= new Date(principal.valid_until))
    throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  let signatureValid = false;
  try {
    const publicKey = createPublicKey(pem(principal.public_key, "app service public key"));
    signatureValid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey,
      Buffer.from(parts[2] ?? "", "base64url"));
  } catch { signatureValid = false; }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || !signatureValid ||
      claims.iss !== principal.client_id || claims.sub !== principal.client_id || claims.aud !== audience ||
      !claims.jti || typeof claims.iat !== "number" || Number(claims.iat) > nowSeconds ||
      typeof claims.exp !== "number" || Number(claims.exp) <= nowSeconds ||
      Number(claims.exp) - Number(claims.iat) > 60 || claims.app_id !== principal.app_id ||
      claims.environment !== principal.environment || claims.deployment_id !== principal.deployment_id)
    throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  return { principal, jti: String(claims.jti), expiresAt: new Date(Number(claims.exp) * 1000).toISOString() };
}

export async function verifyAppClientAssertionWithClient(db: DbClient, assertion: string, now: Date, audience: string) {
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  let header: { alg?: string; typ?: string }; let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch { throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED"); }
  if (typeof claims.iss !== "string") throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  const principal = await db.get<AppPrincipal>("select * from app_service_principals where client_id=?", [claims.iss]);
  if (!principal || principal.status !== "active" || !principal.public_key ||
      now < new Date(principal.valid_from) || now >= new Date(principal.valid_until)) {
    throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  }
  let signatureValid = false;
  try {
    const publicKey = createPublicKey(pem(principal.public_key, "app service public key"));
    signatureValid = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey,
      Buffer.from(parts[2] ?? "", "base64url"));
  } catch { signatureValid = false; }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || !signatureValid ||
      claims.iss !== principal.client_id || claims.sub !== principal.client_id || claims.aud !== audience ||
      !claims.jti || typeof claims.iat !== "number" || Number(claims.iat) > nowSeconds ||
      typeof claims.exp !== "number" || Number(claims.exp) <= nowSeconds || Number(claims.exp) - Number(claims.iat) > 60 ||
      claims.app_id !== principal.app_id || claims.environment !== principal.environment ||
      claims.deployment_id !== principal.deployment_id) throw new AppLaunchError("APP_SERVICE_AUTHENTICATION_FAILED");
  return { principal, jti: String(claims.jti), expiresAt: new Date(Number(claims.exp) * 1000).toISOString() };
}
