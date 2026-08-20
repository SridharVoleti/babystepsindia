import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { createLearner } from "@/lib/db/learner-repo";
import {
  applyEmailChangeToken,
  cancelEmailChange,
  changePassword,
  finalizeEmailChange,
  getSecurityView,
  requestEmailChange,
  resendEmailChange,
  restoreAccount,
  softDeleteAccount,
} from "@/lib/db/account-security-repo";

beforeEach(() => {
  useInMemoryDb();
});

async function signUp(email: string) {
  return (await sqliteAuthAdapter.signUp(email, "CorrectHorse1!")).user;
}

describe("changePassword", () => {
  it("updates the password so the new one works and the old one does not (AT-IA-003-01)", async () => {
    const user = await signUp("parent@example.com");
    await changePassword(user.id, "NewPassword2!");

    expect(
      await sqliteAuthAdapter.signInWithPassword("parent@example.com", "CorrectHorse1!"),
    ).toBeNull();
    expect(
      await sqliteAuthAdapter.signInWithPassword("parent@example.com", "NewPassword2!"),
    ).not.toBeNull();
  });

  it("records an account_events row", async () => {
    const user = await signUp("parent@example.com");
    await changePassword(user.id, "NewPassword2!");

    const count = (
      getDb()
        .prepare(
          "select count(*) as n from account_events where parent_user_id = ? and event_type = 'password_changed'",
        )
        .get(user.id) as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

describe("requestEmailChange / getSecurityView (AT-IA-003-03)", () => {
  it("does not change the login email while pending", async () => {
    const user = await signUp("old@example.com");
    await requestEmailChange(user.id, "old@example.com", "new@example.com");

    expect(await sqliteAuthAdapter.signInWithPassword("old@example.com", "CorrectHorse1!")).not.toBeNull();
    expect(await sqliteAuthAdapter.signInWithPassword("new@example.com", "CorrectHorse1!")).toBeNull();
  });

  it("surfaces the pending request in the security view", async () => {
    const user = await signUp("old@example.com");
    await requestEmailChange(user.id, "old@example.com", "new@example.com");

    const view = await getSecurityView(user.id, "old@example.com");
    expect(view.email).toBe("old@example.com");
    expect(view.pendingEmailChange?.newEmail).toBe("new@example.com");
  });

  it("replaces (cancels) an existing pending request instead of allowing two", async () => {
    const user = await signUp("old@example.com");
    await requestEmailChange(user.id, "old@example.com", "first-new@example.com");
    await requestEmailChange(user.id, "old@example.com", "second-new@example.com");

    const pendingCount = (
      getDb()
        .prepare(
          "select count(*) as n from email_change_requests where parent_user_id = ? and status = 'pending'",
        )
        .get(user.id) as { n: number }
    ).n;
    expect(pendingCount).toBe(1);

    const view = await getSecurityView(user.id, "old@example.com");
    expect(view.pendingEmailChange?.newEmail).toBe("second-new@example.com");
  });
});

describe("resendEmailChange / cancelEmailChange", () => {
  it("issues a fresh token and a later expiry (AT-IA-003-06 negative case)", async () => {
    const user = await signUp("old@example.com");
    const first = await requestEmailChange(user.id, "old@example.com", "new@example.com");

    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000); // ensure a real elapsed gap, not just a fresh Date.now() call
    let resend: Awaited<ReturnType<typeof resendEmailChange>>;
    try {
      resend = await resendEmailChange(user.id);
    } finally {
      vi.useRealTimers();
    }

    expect(resend).not.toBeNull();
    expect(resend!.token).not.toBe(first.token);
    expect(new Date(resend!.expiresAt).getTime()).toBeGreaterThan(new Date(first.expiresAt).getTime());

    // The old token no longer resolves the pending request.
    expect(await applyEmailChangeToken(first.token)).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
  });

  it("returns null when there is nothing pending to resend", async () => {
    const user = await signUp("old@example.com");
    expect(await resendEmailChange(user.id)).toBeNull();
  });

  it("cancels the pending request so the callback can no longer activate it", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");

    expect(await cancelEmailChange(user.id)).toBe(true);
    expect(await applyEmailChangeToken(request.token)).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
    expect((await getSecurityView(user.id, "old@example.com")).pendingEmailChange).toBeNull();
  });

  it("returns false when there is nothing pending to cancel", async () => {
    const user = await signUp("old@example.com");
    expect(await cancelEmailChange(user.id)).toBe(false);
  });
});

describe("applyEmailChangeToken + finalizeEmailChange (AT-IA-003-04/05/08)", () => {
  it("activates the new email immediately and archives the old one exactly once", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");

    const applied = await applyEmailChangeToken(request.token);
    expect(applied).toMatchObject({ ok: true, parentUserId: user.id, newEmail: "new@example.com" });

    await finalizeEmailChange(user.id);

    expect(await sqliteAuthAdapter.signInWithPassword("new@example.com", "CorrectHorse1!")).not.toBeNull();
    expect(await sqliteAuthAdapter.signInWithPassword("old@example.com", "CorrectHorse1!")).toBeNull();

    const history = getDb()
      .prepare("select email from parent_email_history where parent_user_id = ?")
      .all(user.id) as { email: string }[];
    expect(history).toEqual([{ email: "old@example.com" }]);
  });

  it("is idempotent across a replayed callback — no duplicate archival (AT-IA-003-05)", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");
    await applyEmailChangeToken(request.token);
    await finalizeEmailChange(user.id);

    // Replay: same token hit again, finalize called again.
    const replay = await applyEmailChangeToken(request.token);
    expect(replay).toMatchObject({ ok: true, parentUserId: user.id, newEmail: "new@example.com" });
    await finalizeEmailChange(user.id);

    const historyCount = (
      getDb()
        .prepare("select count(*) as n from parent_email_history where parent_user_id = ?")
        .get(user.id) as { n: number }
    ).n;
    expect(historyCount).toBe(1);
  });

  it("completes reconciliation when Auth changed but the archive step didn't run yet (AT-IA-003-08)", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");

    // Step 1 only — simulates "Auth email changed but archival write failed"
    // by simply not calling finalizeEmailChange yet.
    await applyEmailChangeToken(request.token);

    const stillPending = (
      getDb()
        .prepare("select status from email_change_requests where id = ?")
        .get(request.id) as { status: string }
    ).status;
    expect(stillPending).toBe("pending");

    // Reconciliation: finalize runs independently and completes it.
    const first = await finalizeEmailChange(user.id);
    expect(first.archived).toBe(true);

    const second = await finalizeEmailChange(user.id);
    expect(second.archived).toBe(false); // already done — idempotent

    const historyCount = (
      getDb()
        .prepare("select count(*) as n from parent_email_history where parent_user_id = ?")
        .get(user.id) as { n: number }
    ).n;
    expect(historyCount).toBe(1);
  });

  it("rejects an unknown token", async () => {
    expect(await applyEmailChangeToken("does-not-exist")).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
  });

  it("rejects an expired request and leaves the old email active (AT-IA-003-06)", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");
    getDb()
      .prepare("update email_change_requests set expires_at = ? where id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), request.id);

    const applied = await applyEmailChangeToken(request.token);
    expect(applied).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(await sqliteAuthAdapter.signInWithPassword("old@example.com", "CorrectHorse1!")).not.toBeNull();
  });

  it("rejects a cancelled request (AT-IA-003-07 negative case)", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");
    await cancelEmailChange(user.id);

    expect(await applyEmailChangeToken(request.token)).toMatchObject({ ok: false, code: "INVALID_TOKEN" });
  });

  it("rolls back if the archive write fails mid-transaction", async () => {
    const user = await signUp("old@example.com");
    const request = await requestEmailChange(user.id, "old@example.com", "new@example.com");
    await applyEmailChangeToken(request.token);

    getDb().exec("drop table parent_email_history");
    await expect(finalizeEmailChange(user.id)).rejects.toThrow();

    getDb().exec(`
      create table parent_email_history (
        id text primary key,
        parent_user_id text not null references profiles(id) on delete cascade,
        email text not null,
        archived_at text not null default (datetime('now')),
        reason text not null default 'email_changed'
      )
    `);

    const status = (
      getDb()
        .prepare("select status from email_change_requests where id = ?")
        .get(request.id) as { status: string }
    ).status;
    expect(status).toBe("pending");
  });
});

describe("softDeleteAccount / restoreAccount (AT-IA-003-07/09/10/13)", () => {
  it("marks the account deleted, sets revocation fields, and retains everything else", async () => {
    const user = await signUp("parent@example.com");
    const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
      idempotencyKey: "30000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner;
    const product = getDb().prepare("select id,version from products where slug='chess'").get() as { id: string; version: number };
    getDb()
      .prepare(
        `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
         razorpay_subscription_id,current_period_end) values('sub1',?,'single',?,?,?,?, 'rzp_1',datetime('now'))`,
      )
      .run(user.id, product.id, user.id, learner.id, product.version);

    await softDeleteAccount(user.id);

    const profile = getDb()
      .prepare("select * from profiles where id = ?")
      .get(user.id) as {
      account_status: string;
      deleted_at: string | null;
      deleted_by_user_id: string | null;
      auth_revoked_before: string | null;
    };
    expect(profile.account_status).toBe("deleted");
    expect(profile.deleted_at).toBeTruthy();
    expect(profile.deleted_by_user_id).toBe(user.id);
    expect(profile.auth_revoked_before).toBeTruthy();

    // Nothing physically deleted.
    expect(getDb().prepare("select * from users where id = ?").get(user.id)).toBeTruthy();
    expect(getDb().prepare("select * from subscriptions where id = 'sub1'").get()).toBeTruthy();
  });

  it("records an account_soft_deleted event", async () => {
    const user = await signUp("parent@example.com");
    await softDeleteAccount(user.id);

    const count = (
      getDb()
        .prepare(
          "select count(*) as n from account_events where parent_user_id = ? and event_type = 'account_soft_deleted'",
        )
        .get(user.id) as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("admin restore reactivates the account but keeps auth_revoked_before intact", async () => {
    const user = await signUp("parent@example.com");
    const admin = await signUp("admin-user@example.com");
    await softDeleteAccount(user.id);

    const before = getDb()
      .prepare("select auth_revoked_before from profiles where id = ?")
      .get(user.id) as { auth_revoked_before: string };

    await restoreAccount(user.id, admin.id, "Reinstated per support ticket #42");

    const after = getDb()
      .prepare("select * from profiles where id = ?")
      .get(user.id) as {
      account_status: string;
      deleted_at: string | null;
      deleted_by_user_id: string | null;
      auth_revoked_before: string;
    };
    expect(after.account_status).toBe("active");
    expect(after.deleted_at).toBeNull();
    expect(after.deleted_by_user_id).toBeNull();
    expect(after.auth_revoked_before).toBe(before.auth_revoked_before);
  });

  it("records an account_restored event with the reason", async () => {
    const user = await signUp("parent@example.com");
    const admin = await signUp("admin-user@example.com");
    await softDeleteAccount(user.id);
    await restoreAccount(user.id, admin.id, "Reinstated per support ticket #42");

    const event = getDb()
      .prepare(
        "select metadata from account_events where parent_user_id = ? and event_type = 'account_restored'",
      )
      .get(user.id) as { metadata: string };
    expect(JSON.parse(event.metadata)).toMatchObject({
      reason: "Reinstated per support ticket #42",
      restoredBy: admin.id,
    });
  });
});
