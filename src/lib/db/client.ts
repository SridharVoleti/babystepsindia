import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword } from "@/lib/auth/password";

declare global {
  // eslint-disable-next-line no-var
  var __babystepsDb: Database.Database | undefined;
}

// The canonical product catalog (name/subdomain/price/status). Synced into
// `products` on every boot (upsert by slug) rather than seeded once, so
// editing this list is the one place that changes what the app shows —
// no separate "update the DB too" step. Marketing copy (tagline, local dev
// port) lives in `src/lib/products.ts` instead; that's presentation-only,
// not part of the transactional schema.
const CATALOG = [
  { slug: "chess", name: "ChessQuest", subdomain: "chess.babysteps.in", priceInr: 299, status: "active" },
  { slug: "magical-math", name: "Magical Math", subdomain: "math.babysteps.in", priceInr: 299, status: "active" },
  { slug: "speed-reading", name: "Speed Reading", subdomain: "read.babysteps.in", priceInr: 299, status: "active" },
] as const;

function openDb(): Database.Database {
  const dbPath = process.env.SQLITE_DB_PATH ?? "./data/babysteps.db";
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schema = fs.readFileSync(
    path.join(process.cwd(), "src/lib/db/schema.sql"),
    "utf-8",
  );
  db.exec(schema);

  syncProductCatalog(db);
  syncApprovedAppIcons(db);
  seedAdminIfMissing(db);

  return db;
}

// AR-001's local stand-in for the "approved platform asset registry"
// dependency — a small, fixed, admin-curated icon list an app's
// icon_asset_key must reference (and be active) before activation.
const APPROVED_APP_ICONS = [
  { id: "icon-chess-piece", label: "Chess piece" },
  { id: "icon-abacus", label: "Abacus" },
  { id: "icon-open-book", label: "Open book" },
] as const;

function syncApprovedAppIcons(db: Database.Database) {
  const upsert = db.prepare(
    `insert into approved_app_icons (id, label, active) values (?, ?, 1)
     on conflict(id) do update set label = excluded.label, active = 1`,
  );
  const sync = db.transaction(() => {
    for (const icon of APPROVED_APP_ICONS) {
      upsert.run(icon.id, icon.label);
    }
  });
  sync();
}

function syncProductCatalog(db: Database.Database) {
  const upsert = db.prepare(
    `insert into products (id, slug, name, subdomain, razorpay_plan_id, price_inr, status)
     values (@id, @slug, @name, @subdomain, @razorpayPlanId, @priceInr, @status)
     on conflict(slug) do update set
       name = excluded.name,
       subdomain = excluded.subdomain,
       price_inr = excluded.price_inr,
       status = excluded.status`,
  );

  const archiveRemoved = db.prepare(
    `update products set status = 'archived'
     where status != 'archived' and slug not in (${CATALOG.map(() => "?").join(",")})`,
  );

  const sync = db.transaction(() => {
    for (const p of CATALOG) {
      upsert.run({
        id: randomUUID(),
        slug: p.slug,
        name: p.name,
        subdomain: p.subdomain,
        razorpayPlanId: `plan_${p.slug}`,
        priceInr: p.priceInr,
        status: p.status,
      });
    }
    // Products removed from CATALOG are archived, not deleted — a
    // subscription row's product_id may still reference them.
    archiveRemoved.run(...CATALOG.map((p) => p.slug));
  });
  sync();
}

function seedAdminIfMissing(db: Database.Database) {
  const adminCount = (
    db.prepare("select count(*) as n from users where is_admin = 1").get() as {
      n: number;
    }
  ).n;

  if (adminCount === 0) {
    const email = process.env.ADMIN_EMAIL ?? "admin@babysteps.in";
    const password = process.env.ADMIN_PASSWORD ?? "changeme123";
    const userId = randomUUID();

    db.prepare(
      `insert into users (id, email, password_hash, is_admin, email_verified_at)
       values (?, ?, ?, 1, datetime('now'))`,
    ).run(userId, email, hashPassword(password));

    // onboarding_status='complete': an out-of-band-provisioned admin
    // shouldn't be routed through parent-profile onboarding (IA-002).
    db.prepare(
      `insert into profiles (id, display_name, onboarding_status) values (?, ?, 'complete')`,
    ).run(userId, "Admin");

    // AR-001: the bootstrap admin gets every app-registry permission —
    // a fresh install has no other admin to grant them.
    const grantPermission = db.prepare(
      "insert into admin_permissions (user_id, permission) values (?, ?)",
    );
    for (const permission of [
      "app_registry_create",
      "app_registry_edit",
      "app_registry_activate",
      "app_registry_soft_delete",
      "app_registry_restore",
      "analytics_run_retry",
    ]) {
      grantPermission.run(userId, permission);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[babysteps] Seeded local admin account: ${email} / ${password} (set ADMIN_EMAIL / ADMIN_PASSWORD to override)`,
    );
  }
}

export function getDb(): Database.Database {
  if (!global.__babystepsDb) {
    global.__babystepsDb = openDb();
  }
  return global.__babystepsDb;
}

// Test-only: drop the cached connection so the next getDb() call reopens
// against whatever SQLITE_DB_PATH currently points at (see
// src/lib/db/test-utils.ts). A no-op in the running app.
export function resetDbForTests() {
  global.__babystepsDb?.close();
  global.__babystepsDb = undefined;
}
