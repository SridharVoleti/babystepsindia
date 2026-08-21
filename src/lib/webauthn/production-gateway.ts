export { WebAuthnError } from "@/lib/webauthn/postgres-service";
import { WebAuthnError } from "@/lib/webauthn/postgres-service";

const implementation = () => process.env.SUPABASE_DB_URL
  ? import("@/lib/webauthn/postgres-service")
  : import("@/lib/webauthn/service");

async function call<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
      throw new WebAuthnError(error.code);
    }
    throw error;
  }
}

export async function generatePasskeyRegistrationOptions(...args: Parameters<typeof import("./service").generatePasskeyRegistrationOptions>) {
  return call(async () => (await implementation()).generatePasskeyRegistrationOptions(...args));
}
export async function verifyPasskeyRegistration(...args: Parameters<typeof import("./service").verifyPasskeyRegistration>) {
  return call(async () => (await implementation()).verifyPasskeyRegistration(...args));
}
export async function generatePasskeyAuthenticationOptions(...args: Parameters<typeof import("./service").generatePasskeyAuthenticationOptions>) {
  return call(async () => (await implementation()).generatePasskeyAuthenticationOptions(...args));
}
export async function verifyPasskeyAuthenticationAndEnterLearnerMode(...args: Parameters<typeof import("./service").verifyPasskeyAuthenticationAndEnterLearnerMode>) {
  return call(async () => (await implementation()).verifyPasskeyAuthenticationAndEnterLearnerMode(...args));
}
export async function listLearnerPasskeys(...args: Parameters<typeof import("./service").listLearnerPasskeys>) {
  return call(async () => (await implementation()).listLearnerPasskeys(...args));
}
export async function revokeLearnerPasskey(...args: Parameters<typeof import("./service").revokeLearnerPasskey>) {
  return call(async () => (await implementation()).revokeLearnerPasskey(...args));
}
