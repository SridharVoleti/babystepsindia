import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, derivedHex] = stored.split(":");
  if (!salt || !derivedHex) return false;

  const derived = scryptSync(password, salt, KEY_LENGTH);
  const stored_ = Buffer.from(derivedHex, "hex");
  if (derived.length !== stored_.length) return false;

  return timingSafeEqual(derived, stored_);
}
