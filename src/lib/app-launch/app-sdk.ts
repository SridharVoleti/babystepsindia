import { createHash, createSecretKey, randomBytes } from "node:crypto";
import { jwtVerify, type JWTPayload } from "jose";
import { AppLaunchError } from "@/lib/app-launch/service";

export const APP_LOCAL_COOKIE = "bs_app_session";

export type AppLocalSession = {
  idHash: string; learnerSessionId: string; learnerId: string; appId: string;
  deploymentId: string; releaseId: string; expiresAt: string;
};

export interface AppLocalSessionStore {
  create(session: AppLocalSession): void;
  find(idHash: string): AppLocalSession | null;
  delete(idHash: string): void;
}

function key(secret: string) {
  if (secret.length < 32) throw new Error("bootstrap verification secret must be at least 32 characters");
  return createSecretKey(Buffer.from(secret));
}

function requiredString(payload: JWTPayload, claim: string) {
  const value = payload[claim];
  if (typeof value !== "string" || !value) throw new AppLaunchError("BOOTSTRAP_ASSERTION_INVALID");
  return value;
}

// SC-003: this establishes the app-local browser cookie right after LA-001
// exchange (learner identity only) — well before usable launch is
// confirmed. The SC-001 signed envelope isn't issued until then (it's part
// of confirmUsableLaunch's response instead), so it plays no part here.
export async function establishAppLocalSession(input: {
  bootstrapAssertion: string; expectedClientId: string; expectedAppId: string;
  expectedDeploymentId: string; expectedReleaseId: string; centralSessionExpiresAt: string;
  now: Date; verificationSecret: string; store: AppLocalSessionStore;
}) {
  let payload: JWTPayload;
  try {
    payload = (await jwtVerify(input.bootstrapAssertion, key(input.verificationSecret), {
      issuer: "https://babysteps.in", audience: input.expectedClientId,
      algorithms: ["HS256"], currentDate: input.now, clockTolerance: 0,
    })).payload;
  } catch { throw new AppLaunchError("BOOTSTRAP_ASSERTION_INVALID"); }
  const appId = requiredString(payload, "app_id");
  const deploymentId = requiredString(payload, "deployment_id");
  const releaseId = requiredString(payload, "release_id");
  if (appId !== input.expectedAppId || deploymentId !== input.expectedDeploymentId ||
      releaseId !== input.expectedReleaseId) throw new AppLaunchError("BOOTSTRAP_ASSERTION_BINDING_MISMATCH");
  const assertionExpiry = new Date(Number(payload.exp) * 1000);
  const expiresAt = new Date(Math.min(assertionExpiry.getTime(), new Date(input.centralSessionExpiresAt).getTime()));
  if (expiresAt <= input.now) throw new AppLaunchError("BOOTSTRAP_ASSERTION_INVALID");
  const cookieValue = randomBytes(32).toString("base64url");
  const idHash = createHash("sha256").update(cookieValue).digest("hex");
  input.store.create({ idHash, learnerSessionId: requiredString(payload, "learner_session_id"),
    learnerId: requiredString(payload, "learner_id"), appId, deploymentId, releaseId,
    expiresAt: expiresAt.toISOString() });
  return { cookieValue, expiresAt: expiresAt.toISOString(), cookie: {
    name: APP_LOCAL_COOKIE, value: cookieValue, httpOnly: true, secure: true,
    sameSite: "lax" as const, path: "/", expires: expiresAt,
  } };
}

export function endAppLocalSession(cookieValue: string, store: AppLocalSessionStore) {
  store.delete(createHash("sha256").update(cookieValue).digest("hex"));
}

export async function handleAppLaunchPost(input: {
  form: FormData; clientAssertion: string; exchangeIdempotencyKey: string;
  exchange: (request: { launchCode: string; launchAttemptId: string; exchangeIdempotencyKey: string;
    clientAssertion: string }) => Promise<{ bootstrapAssertion: string; centralSessionExpiresAt: string }>;
  expectedClientId: string; expectedAppId: string; expectedDeploymentId: string; expectedReleaseId: string;
  now: Date; verificationSecret: string; store: AppLocalSessionStore;
}) {
  const launchCode = input.form.get("launchCode");
  const launchAttemptId = input.form.get("launchAttemptId");
  if (typeof launchCode !== "string" || !launchCode || typeof launchAttemptId !== "string" || !launchAttemptId) {
    throw new AppLaunchError("LAUNCH_FORM_INVALID");
  }
  const exchanged = await input.exchange({ launchCode, launchAttemptId,
    exchangeIdempotencyKey: input.exchangeIdempotencyKey, clientAssertion: input.clientAssertion });
  return establishAppLocalSession({ bootstrapAssertion: exchanged.bootstrapAssertion,
    centralSessionExpiresAt: exchanged.centralSessionExpiresAt, expectedClientId: input.expectedClientId,
    expectedAppId: input.expectedAppId, expectedDeploymentId: input.expectedDeploymentId,
    expectedReleaseId: input.expectedReleaseId, now: input.now,
    verificationSecret: input.verificationSecret, store: input.store });
}
