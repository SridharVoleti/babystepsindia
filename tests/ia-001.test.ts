import { describe, expect, it } from "vitest";
import { normalizeEmail, passwordError, validateSignup } from "@/lib/auth/validation";
import { ensureParentProfile, parentAccessDecision, type ParentProfileStore } from "@/lib/auth/parent-profile";
describe("IA-001", () => {
  it("normalizes a compliant signup", () => expect(validateSignup({email:" Parent@Example.COM ",password:"CorrectHorse1!",confirmPassword:"CorrectHorse1!",acceptedTerms:true,acceptedPrivacy:true})).toEqual({ok:true,email:"parent@example.com"}));
  it("rejects invalid signup input", () => { expect(normalizeEmail("bad")).toBeNull(); expect(passwordError("short")).toBeTruthy(); expect(validateSignup({email:"p@example.com",password:"CorrectHorse1!",confirmPassword:"no",acceptedTerms:true,acceptedPrivacy:true}).ok).toBe(false); });
  it("recovers one profile idempotently", async () => { const rows=new Map<string,any>(); const store:ParentProfileStore={find:async id=>rows.get(id)??null,insert:async id=>{const p={id,account_status:"active" as const,onboarding_status:"profile_pending" as const};rows.set(id,p);return p;}}; expect((await ensureParentProfile(store,"u")).created).toBe(true);expect((await ensureParentProfile(store,"u")).created).toBe(false);expect(rows.size).toBe(1); });
  it("denies unverified and inactive profiles", () => { expect(parentAccessDecision({emailVerified:false,profile:null}).code).toBe("EMAIL_NOT_VERIFIED"); expect(parentAccessDecision({emailVerified:true,profile:{account_status:"suspended"}}).allowed).toBe(false); });
});
