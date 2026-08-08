// A minimal, real ES256 WebAuthn "authenticator" for tests: it produces
// genuine CBOR-encoded attestation/assertion objects and ECDSA signatures
// so tests exercise @simplewebauthn/server's actual verification path
// rather than mocking it away.
import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

function b64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(value: Uint8Array | string) {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function concat(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function u16be(value: number) {
  const out = new Uint8Array(2);
  out[0] = (value >> 8) & 0xff; out[1] = value & 0xff;
  return out;
}

function u32be(value: number) {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff; out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff; out[3] = value & 0xff;
  return out;
}

export type VirtualAuthenticator = {
  credentialId: Uint8Array;
  privateKey: KeyObject;
  cosePublicKey: Uint8Array;
};

export function createVirtualAuthenticator(): VirtualAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const coseMap = new Map<string | number, CBORType>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, new Uint8Array(x)],
    [-3, new Uint8Array(y)],
  ]);
  return {
    credentialId: new Uint8Array(Buffer.from(crypto.randomUUID().replaceAll("-", ""), "hex")),
    privateKey: createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }) as string),
    cosePublicKey: encodeCBOR(coseMap),
  };
}

function clientDataJSON(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export function buildRegistrationResponse(auth: VirtualAuthenticator, input: {
  rpID: string; origin: string; challenge: string;
}): RegistrationResponseJSON {
  const rpIdHash = sha256(input.rpID);
  const flags = new Uint8Array([0x45]); // UP | UV | AT
  const signCount = u32be(0);
  const aaguid = new Uint8Array(16);
  const credIdLen = u16be(auth.credentialId.length);
  const attestedCredentialData = concat(aaguid, credIdLen, auth.credentialId, auth.cosePublicKey);
  const authData = concat(rpIdHash, flags, signCount, attestedCredentialData);
  const attestationObject = encodeCBOR(new Map<string | number, CBORType>([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]));
  const clientData = clientDataJSON("webauthn.create", input.challenge, input.origin);
  return {
    id: b64url(auth.credentialId),
    rawId: b64url(auth.credentialId),
    response: {
      clientDataJSON: b64url(clientData),
      attestationObject: b64url(attestationObject),
      transports: ["internal"],
    },
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

export function buildAuthenticationResponse(auth: VirtualAuthenticator, input: {
  rpID: string; origin: string; challenge: string; signCount: number;
}): AuthenticationResponseJSON {
  const rpIdHash = sha256(input.rpID);
  const flags = new Uint8Array([0x05]); // UP | UV, no AT
  const authData = concat(rpIdHash, flags, u32be(input.signCount));
  const clientData = clientDataJSON("webauthn.get", input.challenge, input.origin);
  const signedData = concat(authData, sha256(clientData));
  const signature = sign("sha256", Buffer.from(signedData), { key: auth.privateKey, dsaEncoding: "der" });
  return {
    id: b64url(auth.credentialId),
    rawId: b64url(auth.credentialId),
    response: {
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(new Uint8Array(signature)),
    },
    type: "public-key",
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}
