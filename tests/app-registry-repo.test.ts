import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { AppRegistryError } from "@/lib/app-registry/validation";
import {
  activateApp,
  assertAppOperational,
  createApp,
  editApp,
  getApp,
  listApps,
  restoreApp,
  softDeleteApp,
} from "@/lib/db/app-registry-repo";
import type { EnvironmentReadinessAdapter } from "@/lib/app-registry/readiness-adapter";

// app_registry_mutation_requests.admin_user_id references users(id), so
// the admin acting on the registry must be a real row — same reasoning
// as LP-001/002's tests creating a real parent via sqliteAuthAdapter.signUp.
let ADMIN: string;

beforeEach(async () => {
  useInMemoryDb();
  ADMIN = (await sqliteAuthAdapter.signUp("admin-actor@example.com", "CorrectHorse1!")).user.id;
});

function key(n: number) {
  return `${"1".repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

const validCreateInput = {
  appKey: "chess-master",
  displayName: "Chess Master",
  idempotencyKey: key(1),
};

function readyAdapter(ready = true): EnvironmentReadinessAdapter {
  return { checkReady: async () => (ready ? { ready: true } : { ready: false, reason: "not configured" }) };
}

async function createAndCompleteMetadata(idemSuffix: number, appKey = "chess-master") {
  const created = await createApp(ADMIN, { ...validCreateInput, appKey, idempotencyKey: key(idemSuffix) });
  const edited = await editApp(ADMIN, created.id, {
    shortDescription: "Guided chess lessons and puzzles.",
    iconAssetKey: "icon-chess-piece",
    category: "learning",
    owningTeam: "platform",
    expectedVersion: created.version,
    idempotencyKey: key(idemSuffix + 100),
  });
  return edited;
}

describe("createApp (AC2/AC3/AC4)", () => {
  it("creates a draft app with a generated UUID and version 1", async () => {
    const app = await createApp(ADMIN, validCreateInput);
    expect(app.registryStatus).toBe("draft");
    expect(app.version).toBe(1);
    expect(app.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(app.appKey).toBe("chess-master");
  });

  it("writes an audit event", async () => {
    const app = await createApp(ADMIN, validCreateInput);
    const events = getDb()
      .prepare("select operation from app_registry_audit_log where app_id = ?")
      .all(app.id) as { operation: string }[];
    expect(events).toEqual([{ operation: "create" }]);
  });

  it("rejects an invalid app key (AT-AR-001-03)", async () => {
    await expect(createApp(ADMIN, { ...validCreateInput, appKey: "Invalid Key!" })).rejects.toThrowError(
      new AppRegistryError("APP_KEY_INVALID"),
    );
  });

  it("rejects a duplicate app key (AT-AR-001-04)", async () => {
    await createApp(ADMIN, validCreateInput);
    await expect(
      createApp(ADMIN, { ...validCreateInput, idempotencyKey: key(2) }),
    ).rejects.toThrowError(new AppRegistryError("APP_KEY_ALREADY_EXISTS"));

    const count = (
      getDb().prepare("select count(*) as n from app_registry where app_key = ?").get("chess-master") as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });

  it("replays the original result for the same idempotency key and payload", async () => {
    const first = await createApp(ADMIN, validCreateInput);
    const second = await createApp(ADMIN, validCreateInput);
    expect(second).toEqual(first);

    const count = (
      getDb().prepare("select count(*) as n from app_registry").get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("rejects a conflicting payload reused under the same idempotency key (AT-AR-001-26)", async () => {
    await createApp(ADMIN, validCreateInput);
    await expect(
      createApp(ADMIN, { ...validCreateInput, displayName: "Different Name" }),
    ).rejects.toThrowError(new AppRegistryError("IDEMPOTENCY_KEY_REUSED"));
  });
});

describe("editApp (AC5/AC6/AC7)", () => {
  it("updates mutable fields and increments version", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    const edited = await editApp(ADMIN, created.id, {
      displayName: "Chess Master Pro",
      expectedVersion: created.version,
      idempotencyKey: key(2),
    });
    expect(edited.displayName).toBe("Chess Master Pro");
    expect(edited.version).toBe(2);
    expect(edited.appKey).toBe("chess-master");
    expect(edited.id).toBe(created.id);
  });

  it("does not increment version or write an event for an exact no-op (AT-AR-001-07)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    const edited = await editApp(ADMIN, created.id, {
      displayName: "Chess Master",
      expectedVersion: created.version,
      idempotencyKey: key(2),
    });
    expect(edited.version).toBe(1);

    const eventCount = (
      getDb().prepare("select count(*) as n from app_registry_audit_log where app_id = ?").get(created.id) as {
        n: number;
      }
    ).n;
    expect(eventCount).toBe(1); // only the create event, no edit event
  });

  it("rejects a stale expectedVersion (AT-AR-001-08)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await editApp(ADMIN, created.id, {
      displayName: "V2 name",
      expectedVersion: 1,
      idempotencyKey: key(2),
    });

    await expect(
      editApp(ADMIN, created.id, {
        displayName: "V3 name",
        expectedVersion: 1, // stale — actual version is now 2
        idempotencyKey: key(3),
      }),
    ).rejects.toThrowError(new AppRegistryError("APP_VERSION_CONFLICT"));

    expect((await getApp(created.id))?.displayName).toBe("V2 name");
  });

  it("never changes id or app_key regardless of what's requested (identity immutability enforced upstream by field allowlisting)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    const edited = await editApp(ADMIN, created.id, {
      displayName: "Renamed",
      expectedVersion: created.version,
      idempotencyKey: key(2),
    });
    expect(edited.id).toBe(created.id);
    expect(edited.appKey).toBe(created.appKey);
  });

  it("throws APP_NOT_FOUND for an unknown app", async () => {
    await expect(
      editApp(ADMIN, "does-not-exist", { displayName: "x", expectedVersion: 1, idempotencyKey: key(1) }),
    ).rejects.toThrowError(new AppRegistryError("APP_NOT_FOUND"));
  });
});

describe("activateApp (AC9/AC10/AC11)", () => {
  it("activates a fully-configured draft and increments version", async () => {
    const edited = await createAndCompleteMetadata(1);
    const activated = await activateApp(
      ADMIN,
      edited.id,
      { expectedVersion: edited.version, idempotencyKey: key(3) },
      readyAdapter(true),
    );
    expect(activated.registryStatus).toBe("active");
    expect(activated.version).toBe(edited.version + 1);
    expect(activated.activatedAt).toBeTruthy();
  });

  it("blocks activation when metadata is incomplete (AT-AR-001-12)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await expect(
      activateApp(ADMIN, created.id, { expectedVersion: created.version, idempotencyKey: key(2) }, readyAdapter(true)),
    ).rejects.toThrowError(new AppRegistryError("APP_NOT_READY_FOR_ACTIVATION"));

    expect((await getApp(created.id))?.registryStatus).toBe("draft");
  });

  it("rejects an unapproved icon at write time, not deferred to activation", async () => {
    // Icon approval is checked whenever icon_asset_key is set (create or
    // edit), not just at activation — "arbitrary remote icon URLs are
    // prohibited" (business rule 8) means an invalid reference should
    // never be stored in the first place.
    const created = await createApp(ADMIN, validCreateInput);
    await expect(
      editApp(ADMIN, created.id, {
        shortDescription: "desc",
        iconAssetKey: "icon-not-real",
        category: "learning",
        owningTeam: "platform",
        expectedVersion: created.version,
        idempotencyKey: key(2),
      }),
    ).rejects.toThrowError(new AppRegistryError("APP_ICON_NOT_AVAILABLE"));

    expect((await getApp(created.id))?.iconAssetKey).toBeNull();
  });

  it("blocks activation when the icon was approved at write time but later deactivated", async () => {
    const edited = await createAndCompleteMetadata(1);
    getDb().prepare("update approved_app_icons set active = 0 where id = ?").run(edited.iconAssetKey);

    await expect(
      activateApp(ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(3) }, readyAdapter(true)),
    ).rejects.toThrowError(new AppRegistryError("APP_ICON_NOT_AVAILABLE"));
  });

  it("blocks activation when the environment readiness adapter reports not ready", async () => {
    const edited = await createAndCompleteMetadata(1);
    await expect(
      activateApp(ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(3) }, readyAdapter(false)),
    ).rejects.toThrowError(new AppRegistryError("APP_NOT_READY_FOR_ACTIVATION"));

    expect((await getApp(edited.id))?.registryStatus).toBe("draft");
  });

  it("treats activating an already-active app as a no-op", async () => {
    const edited = await createAndCompleteMetadata(1);
    const first = await activateApp(
      ADMIN,
      edited.id,
      { expectedVersion: edited.version, idempotencyKey: key(3) },
      readyAdapter(true),
    );
    const second = await activateApp(
      ADMIN,
      edited.id,
      { expectedVersion: first.version, idempotencyKey: key(4) },
      readyAdapter(true),
    );
    expect(second.version).toBe(first.version);
    expect(second.registryStatus).toBe("active");
  });
});

describe("assertAppOperational (AC9/AT-AR-001-10/AT-AR-001-19)", () => {
  it("passes for an active app", async () => {
    const edited = await createAndCompleteMetadata(1);
    const activated = await activateApp(
      ADMIN,
      edited.id,
      { expectedVersion: edited.version, idempotencyKey: key(3) },
      readyAdapter(true),
    );
    await expect(assertAppOperational(activated.id)).resolves.not.toThrow();
  });

  it("rejects a draft app", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await expect(assertAppOperational(created.id)).rejects.toThrowError(new AppRegistryError("APP_NOT_ACTIVE"));
  });

  it("rejects an unknown app id (AT-AR-001-15) without ever creating one", async () => {
    await expect(assertAppOperational("unknown-id")).rejects.toThrowError(new AppRegistryError("APP_NOT_FOUND"));
    expect(getDb().prepare("select count(*) as n from app_registry").get()).toEqual({ n: 0 });
  });
});

describe("softDeleteApp (AC15-AC20)", () => {
  it("soft-deletes an active app and increments version", async () => {
    const edited = await createAndCompleteMetadata(1);
    const activated = await activateApp(
      ADMIN,
      edited.id,
      { expectedVersion: edited.version, idempotencyKey: key(3) },
      readyAdapter(true),
    );

    const deleted = await softDeleteApp(ADMIN, activated.id, {
      expectedVersion: activated.version,
      idempotencyKey: key(4),
      reasonCode: "no_longer_supported",
      confirmationAppKey: "chess-master",
    });

    expect(deleted.registryStatus).toBe("soft_deleted");
    expect(deleted.version).toBe(activated.version + 1);
    expect(deleted.softDeletedAt).toBeTruthy();
  });

  it("rejects a confirmation that doesn't match the app_key exactly (AT-AR-001-17)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await expect(
      softDeleteApp(ADMIN, created.id, {
        expectedVersion: created.version,
        idempotencyKey: key(2),
        reasonCode: "test",
        confirmationAppKey: "wrong-key",
      }),
    ).rejects.toThrowError(new AppRegistryError("CONFIRMATION_MISMATCH"));

    expect((await getApp(created.id))?.registryStatus).toBe("draft");
  });

  it("retains the row and identity — nothing is physically deleted (AC18/AT-AR-001-21)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await softDeleteApp(ADMIN, created.id, {
      expectedVersion: created.version,
      idempotencyKey: key(2),
      reasonCode: "test",
      confirmationAppKey: "chess-master",
    });

    const row = await getApp(created.id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(created.id);
    expect(row?.appKey).toBe("chess-master");
    expect(row?.displayName).toBe("Chess Master");
  });

  it("keeps the app_key permanently reserved after soft deletion (AC23/AT-AR-001-24)", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    await softDeleteApp(ADMIN, created.id, {
      expectedVersion: created.version,
      idempotencyKey: key(2),
      reasonCode: "test",
      confirmationAppKey: "chess-master",
    });

    await expect(createApp(ADMIN, { ...validCreateInput, idempotencyKey: key(3) })).rejects.toThrowError(
      new AppRegistryError("APP_KEY_ALREADY_EXISTS"),
    );
  });

  it("rolls back entirely if the transaction fails partway (AT-AR-001-28)", async () => {
    const created = await createApp(ADMIN, validCreateInput);

    getDb().exec("drop table app_registry_audit_log");
    await expect(
      softDeleteApp(ADMIN, created.id, {
        expectedVersion: created.version,
        idempotencyKey: key(2),
        reasonCode: "test",
        confirmationAppKey: "chess-master",
      }),
    ).rejects.toThrow();

    getDb().exec(`
      create table app_registry_audit_log (
        id text primary key,
        app_id text not null,
        app_key text not null,
        operation text not null,
        admin_user_id text not null,
        reason_code text,
        version_from integer,
        version_to integer,
        created_at text not null default (datetime('now'))
      )
    `);

    const row = await getApp(created.id);
    expect(row?.registryStatus).toBe("draft");
    expect(row?.version).toBe(1);
  });
});

describe("restoreApp (AC21/AC22)", () => {
  it("restores a soft-deleted app to draft, keeping the same id/key", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    const deleted = await softDeleteApp(ADMIN, created.id, {
      expectedVersion: created.version,
      idempotencyKey: key(2),
      reasonCode: "test",
      confirmationAppKey: "chess-master",
    });

    const restored = await restoreApp(ADMIN, deleted.id, {
      expectedVersion: deleted.version,
      idempotencyKey: key(3),
      reasonCode: "restored in error",
    });

    expect(restored.registryStatus).toBe("draft");
    expect(restored.id).toBe(created.id);
    expect(restored.appKey).toBe("chess-master");
    expect(restored.version).toBe(deleted.version + 1);
  });

  it("rejects a stale expectedVersion on restore", async () => {
    const created = await createApp(ADMIN, validCreateInput);
    const deleted = await softDeleteApp(ADMIN, created.id, {
      expectedVersion: created.version,
      idempotencyKey: key(2),
      reasonCode: "test",
      confirmationAppKey: "chess-master",
    });

    await expect(
      restoreApp(ADMIN, deleted.id, {
        expectedVersion: created.version, // stale
        idempotencyKey: key(3),
        reasonCode: "x",
      }),
    ).rejects.toThrowError(new AppRegistryError("APP_VERSION_CONFLICT"));
  });
});

describe("listApps (AC29)", () => {
  it("excludes soft-deleted apps by default", async () => {
    const a = await createApp(ADMIN, { ...validCreateInput, appKey: "app-a", idempotencyKey: key(1) });
    const b = await createApp(ADMIN, { ...validCreateInput, appKey: "app-b", idempotencyKey: key(2) });
    await softDeleteApp(ADMIN, b.id, {
      expectedVersion: b.version,
      idempotencyKey: key(3),
      reasonCode: "test",
      confirmationAppKey: "app-b",
    });

    const list = await listApps({});
    expect(list.map((a2) => a2.id)).toEqual([a.id]);
  });

  it("includes soft-deleted apps only when explicitly requested", async () => {
    const a = await createApp(ADMIN, { ...validCreateInput, appKey: "app-a", idempotencyKey: key(1) });
    const b = await createApp(ADMIN, { ...validCreateInput, appKey: "app-b", idempotencyKey: key(2) });
    await softDeleteApp(ADMIN, b.id, {
      expectedVersion: b.version,
      idempotencyKey: key(3),
      reasonCode: "test",
      confirmationAppKey: "app-b",
    });

    const list = await listApps({ includeSoftDeleted: true });
    expect(list.map((a2) => a2.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe("safe read model (AC24)", () => {
  it("never exposes internal_notes", async () => {
    const created = await createApp(ADMIN, { ...validCreateInput, internalNotes: "sensitive ops note" });
    const view = await getApp(created.id);
    expect(view).not.toHaveProperty("internalNotes");
    expect(JSON.stringify(view)).not.toContain("sensitive ops note");
  });
});

describe("audit trail (AC25/AC30)", () => {
  it("records minimal fields only — no metadata snapshot", async () => {
    const edited = await createAndCompleteMetadata(1);
    await activateApp(ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(3) }, readyAdapter(true));

    const events = getDb()
      .prepare("select * from app_registry_audit_log where app_id = ? order by created_at")
      .all(edited.id) as Record<string, unknown>[];

    expect(events.map((e) => e.operation)).toEqual(["create", "edit", "activate"]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        [
          "admin_user_id",
          "app_id",
          "app_key",
          "created_at",
          "id",
          "operation",
          "reason_code",
          "version_from",
          "version_to",
        ].sort(),
      );
    }
  });
});
