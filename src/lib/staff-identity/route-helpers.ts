import { NextResponse } from "next/server";
import { StaffIdentityError, staffIdentityErrorStatus } from "@/lib/staff-identity/errors";
import { StaffWebAuthnError } from "@/lib/webauthn/staff-service";

export function staffFailure(error: unknown): NextResponse {
  if (error instanceof StaffIdentityError) {
    return NextResponse.json({ error: error.code }, { status: staffIdentityErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
  }
  if (error instanceof StaffWebAuthnError) {
    const status =
      error.code === "RESOURCE_NOT_FOUND" ? 404 :
      error.code === "WEBAUTHN_NOT_CONFIGURED" ? 503 :
      error.code === "WEBAUTHN_CHALLENGE_INVALID" ? 409 :
      error.code === "NO_PASSKEY_REGISTERED" ? 409 : 400;
    return NextResponse.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
  }
  throw error;
}
