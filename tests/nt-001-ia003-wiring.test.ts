// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { applyEmailChangeToken, changePassword, finalizeEmailChange, requestEmailChange } from
  "@/lib/db/account-security-repo";

beforeEach(() => { useInMemoryDb(); });

async function signUp(email: string) {
  return (await sqliteAuthAdapter.signUp(email, "CorrectHorse1!")).user;
}

function intentsFor(sourceEventKeyPrefix: string) {
  return getDb().prepare(
    "select * from transactional_notification_intents where source_event_key like ? order by created_at",
  ).all(`${sourceEventKeyPrefix}%`) as any[];
}

describe("NT-001 real wiring: IA-003 (AT-NT-001-21)", () => {
  it("AT-NT-001-21: changing the password enqueues exactly one account_password_changed notification", async () => {
    const user = await signUp("nt001-ia003-a@example.com");
    changePassword(user.id, "NewPassword2!");
    const intents = intentsFor(`password-changed:${user.id}:`);
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("account_password_changed");
    expect(intents[0].parent_id).toBe(user.id);
  });

  it("AT-NT-001-21: a verified email change enqueues exactly one account_email_changed notification", async () => {
    const user = await signUp("nt001-ia003-b-old@example.com");
    const issued = requestEmailChange(user.id, "nt001-ia003-b-old@example.com", "nt001-ia003-b-new@example.com");
    applyEmailChangeToken(issued.token);
    finalizeEmailChange(user.id);
    const request = getDb().prepare("select id from email_change_requests where parent_user_id=?").get(user.id) as
      { id: string };
    const intents = intentsFor(`email-changed:${request.id}`);
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("account_email_changed");
    expect(intents[0].parent_id).toBe(user.id);
  });

  it("a replayed finalizeEmailChange call does not create a second notification", async () => {
    const user = await signUp("nt001-ia003-c-old@example.com");
    const issued = requestEmailChange(user.id, "nt001-ia003-c-old@example.com", "nt001-ia003-c-new@example.com");
    applyEmailChangeToken(issued.token);
    finalizeEmailChange(user.id);
    finalizeEmailChange(user.id); // idempotent no-op per its own established contract
    const request = getDb().prepare("select id from email_change_requests where parent_user_id=?").get(user.id) as
      { id: string };
    expect(intentsFor(`email-changed:${request.id}`)).toHaveLength(1);
  });
});
