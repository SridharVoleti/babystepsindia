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
  { slug: "chess", name: "ChessQuest", subdomain: "chess.babysteps.in", priceInr: 299,
    productType: "individual_app", version: 1, status: "active" },
  { slug: "magical-math", name: "Magical Math", subdomain: "math.babysteps.in", priceInr: 299,
    productType: "individual_app", version: 1, status: "active" },
  { slug: "speed-reading", name: "Speed Reading", subdomain: "read.babysteps.in", priceInr: 299,
    productType: "individual_app", version: 1, status: "active" },
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

  migrateLegacyBi001Columns(db);
  migrateLegacyBi002Columns(db);
  migrateLegacyBi004Columns(db);
  migrateLegacyBi003Columns(db, schema);
  migrateLegacyUl002SessionSchema(db, schema);
  migrateLegacyEg004ProgressSummary(db);
  db.exec(schema);

  syncProductCatalog(db);
  syncProductPrices(db);
  syncApprovedAppIcons(db);
  syncApprovedDomains(db);
  seedAdminIfMissing(db);
  backfillAnalyticsReadPermission(db);

  return db;
}

function migrateLegacyBi004Columns(db: Database.Database) {
  if (!tableExists(db, "subscriptions")) return;
  const columns = columnNames(db, "subscriptions");
  const additions = [
    ["provider_mandate_status", "text not null default 'unknown'"],
    ["cancellation_requested_at", "text"], ["cancellation_effective_at", "text"],
    ["cancellation_reversed_at", "text"], ["cancellation_reason_code", "text"],
    ["cancellation_version", "integer not null default 1"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`alter table subscriptions add column ${name} ${definition}`);
  }
  db.exec(`update subscriptions set provider_mandate_status='valid'
    where provider_mandate_ref is not null and provider_mandate_status='unknown';
    update subscriptions set cancellation_requested_at=coalesce(cancellation_requested_at,updated_at),
      cancellation_effective_at=coalesce(cancellation_effective_at,current_period_end),
      cancellation_reason_code=coalesce(cancellation_reason_code,'self_service')
    where cancel_at_period_end=1;`);
}

function tableExists(db: Database.Database, table: string) {
  return !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(table);
}

function columnNames(db: Database.Database, table: string) {
  return new Set((db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

function migrateLegacyEg004ProgressSummary(db: Database.Database) {
  if (tableExists(db, "learner_app_progress")) {
    const columns = columnNames(db, "learner_app_progress");
    if (!columns.has("progress_summary_version")) {
      db.exec("alter table learner_app_progress add column progress_summary_version integer not null default 0");
    }
    if (!columns.has("progress_summary_state_hash")) {
      db.exec("alter table learner_app_progress add column progress_summary_state_hash text");
    }
  }
  if (!tableExists(db, "progress_mutation_requests")) return;
  const definition = db.prepare("select sql from sqlite_master where type='table' and name='progress_mutation_requests'")
    .get() as { sql: string } | undefined;
  if (definition?.sql.includes("summary_write")) return;
  db.exec(`alter table progress_mutation_requests rename to progress_mutation_requests_eg004_legacy;
    create table progress_mutation_requests (
      app_principal_id text not null references app_service_principals(id),
      grant_id text not null references app_session_grants(id),
      learner_session_id text not null references learner_sessions(id),
      idempotency_key text not null,
      operation text not null check(operation in ('checkpoint','lesson_complete','summary_write')),
      request_hash text not null,
      response_json text not null,
      expires_at text not null,
      created_at text not null,
      primary key(app_principal_id,grant_id,learner_session_id,idempotency_key)
    );
    insert into progress_mutation_requests select * from progress_mutation_requests_eg004_legacy;
    drop table progress_mutation_requests_eg004_legacy;`);
}

// Local SQLite databases predate BI-001 and are schema-initialized with
// CREATE TABLE IF NOT EXISTS rather than the Supabase migration runner.
// Add the compatible columns before schema.sql creates BI-001 indexes and
// triggers. Ambiguous legacy active rows are ended, never assigned to an
// arbitrary learner.
function migrateLegacyBi001Columns(db: Database.Database) {
  if (tableExists(db, "products")) {
    const columns = columnNames(db, "products");
    if (!columns.has("product_type")) db.exec("alter table products add column product_type text not null default 'individual_app'");
    if (!columns.has("version")) db.exec("alter table products add column version integer not null default 1");
  }
  if (!tableExists(db, "subscriptions")) return;
  const columns = columnNames(db, "subscriptions");
  const additions = [
    ["purchaser_parent_id", "text references profiles(id)"],
    ["assigned_learner_id", "text references learners(id)"],
    ["product_version", "integer not null default 1"],
    ["provider_customer_ref", "text"],
    ["current_period_start", "text"],
    ["pending_reassignment_learner_id", "text references learners(id)"],
    ["pending_reassignment_effective_at", "text"],
    ["assignment_version", "integer not null default 1"],
    ["version", "integer not null default 1"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`alter table subscriptions add column ${name} ${definition}`);
  }
  if (db.prepare("select 1 from subscriptions where product_id is null limit 1").get()) {
    db.prepare(
      `insert or ignore into products(id,slug,name,subdomain,razorpay_plan_id,price_inr,product_type,version,status)
       values(?,'legacy-bundle','Legacy bundle','bundle.babysteps.in','legacy_bundle',0,'bundle',1,'archived')`,
    ).run(randomUUID());
    db.exec("update subscriptions set product_id=(select id from products where slug='legacy-bundle') where product_id is null");
  }
  db.exec(`update subscriptions set purchaser_parent_id=user_id where purchaser_parent_id is null;
    update subscriptions set current_period_start=started_at where current_period_start is null;
    update subscriptions set assigned_learner_id=(
      select min(l.id) from learners l where l.owner_parent_id=subscriptions.user_id having count(*)=1
    ) where assigned_learner_id is null;
    update subscriptions set status='expired'
      where assigned_learner_id is null and status in ('active','cancelling','past_due');`);
}

// BI-002 stays additive for local databases created before price snapshots,
// recurring consent and provider-event processing existed. Old/manual grants
// remain non-renewing unless a future explicit parent flow enables renewal.
function migrateLegacyBi002Columns(db: Database.Database) {
  if (tableExists(db, "subscriptions")) {
    const columns = columnNames(db, "subscriptions");
    const additions = [
      ["auto_renew_enabled", "integer not null default 0"],
      ["provider", "text not null default 'legacy'"],
      ["provider_environment", "text not null default 'test'"],
      ["provider_account_id", "text"],
      ["provider_payment_method_ref", "text"],
      ["provider_mandate_ref", "text"],
      ["provider_subscription_ref", "text"],
      ["billing_price_id", "text"],
      ["billing_price_version", "integer"],
      ["payment_state", "text not null default 'paid'"],
      ["next_renewal_at", "text"],
      ["billing_anchor_at", "text"],
      ["original_anchor_day", "integer"],
      ["original_anchor_time", "text"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.exec(`alter table subscriptions add column ${name} ${definition}`);
    }
    db.exec(`update subscriptions set provider_subscription_ref=razorpay_subscription_id
      where provider_subscription_ref is null;
      update subscriptions set billing_anchor_at=current_period_start
      where billing_anchor_at is null;
      update subscriptions set original_anchor_day=cast(strftime('%d',billing_anchor_at) as integer)
      where original_anchor_day is null and billing_anchor_at is not null;
      update subscriptions set original_anchor_time=strftime('%H:%M:%f',billing_anchor_at)
      where original_anchor_time is null and billing_anchor_at is not null;`);
  }
  if (tableExists(db, "checkout_intents")) {
    const columns = columnNames(db, "checkout_intents");
    const additions = [
      ["price_id", "text"], ["price_version", "integer"], ["amount", "integer"],
      ["currency", "text"], ["billing_interval", "text"], ["interval_count", "integer"],
      ["auto_renew_enabled", "integer"], ["consent_disclosure_version", "text"],
      ["consented_at", "text"], ["provider_payment_ref", "text"],
      ["provider_mandate_ref", "text"], ["provider_environment", "text"],
      ["provider_account_id", "text"], ["overlap_source_hash", "text"],
    ] as const;
    for (const [name, definition] of additions) {
      if (!columns.has(name)) db.exec(`alter table checkout_intents add column ${name} ${definition}`);
    }
  }
}

// BI-003 adds only nullable grace metadata plus a monotonic recovery version;
// the event/attempt/session receipt tables are created by schema.sql below.
function migrateLegacyBi003Columns(db: Database.Database, canonicalSchema: string) {
  if (!tableExists(db, "subscriptions")) return;
  const columns = columnNames(db, "subscriptions");
  const additions = [
    ["grace_started_at", "text"], ["grace_ends_at", "text"],
    ["renewal_failure_at", "text"], ["last_recovery_attempt_at", "text"],
    ["recovery_version", "integer not null default 1"], ["nonpayment_ended_at", "text"],
    ["provider_retry_stop_state", "text"],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec(`alter table subscriptions add column ${name} ${definition}`);
  }
  const createSql = (db.prepare(
    "select sql from sqlite_master where type='table' and name='subscriptions'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (createSql.includes("past_due_grace") && createSql.includes("inactive_nonpayment")) return;

  // SQLite cannot ALTER a CHECK constraint. Rebuild only this exact table
  // from the canonical schema, copying every current column while foreign-key
  // enforcement is temporarily disabled. Dependent rows continue to point at
  // the same `subscriptions` name after the shadow table is renamed.
  const marker = "create table if not exists subscriptions (";
  const start = canonicalSchema.indexOf(marker);
  const terminator = "\n);\n\ncreate index if not exists idx_subscriptions_user";
  const end = canonicalSchema.indexOf(terminator, start);
  if (start < 0 || end < 0) throw new Error("Canonical subscriptions schema block not found");
  const shadowDdl = canonicalSchema.slice(start, end + 3)
    .replace(marker, "create table subscriptions_bi003_shadow (");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("drop table if exists subscriptions_bi003_shadow");
      db.exec(shadowDdl);
      const sourceColumns = columnNames(db, "subscriptions");
      const targetColumns = columnNames(db, "subscriptions_bi003_shadow");
      const copyColumns = [...sourceColumns].filter((column) => targetColumns.has(column));
      const quoted = copyColumns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
      db.exec(`insert into subscriptions_bi003_shadow(${quoted}) select ${quoted} from subscriptions`);
      db.exec("drop table subscriptions");
      db.exec("alter table subscriptions_bi003_shadow rename to subscriptions");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// UL-002 adds a durable `resumable` status. SQLite cannot widen the
// learner_sessions CHECK constraint in place, so local databases created
// before UL-002 are rebuilt from the canonical definition while preserving
// every column they already have. Supabase uses migration 0051 instead.
function migrateLegacyUl002SessionSchema(db: Database.Database, canonicalSchema: string) {
  if (!tableExists(db, "learner_sessions")) return;
  const createSql = (db.prepare(
    "select sql from sqlite_master where type='table' and name='learner_sessions'",
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (createSql.includes("'resumable'")) return;

  const marker = "create table if not exists learner_sessions (";
  const start = canonicalSchema.indexOf(marker);
  const terminator = "\n);\n\n-- UL-002: exact-once";
  const end = canonicalSchema.indexOf(terminator, start);
  if (start < 0 || end < 0) throw new Error("Canonical learner_sessions schema block not found");
  const shadowDdl = canonicalSchema.slice(start, end + 3)
    .replace(marker, "create table learner_sessions_ul002_shadow (");

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("drop table if exists learner_sessions_ul002_shadow");
      db.exec(shadowDdl);
      const sourceColumns = columnNames(db, "learner_sessions");
      const targetColumns = columnNames(db, "learner_sessions_ul002_shadow");
      const copyColumns = [...sourceColumns].filter((column) => targetColumns.has(column));
      const quoted = copyColumns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
      db.exec(`insert into learner_sessions_ul002_shadow(${quoted}) select ${quoted} from learner_sessions`);
      db.exec("drop table learner_sessions");
      db.exec("alter table learner_sessions_ul002_shadow rename to learner_sessions");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// AN-001: anyone already trusted to retry analytics runs must retain access
// to the read surfaces after analytics_read becomes a separate permission.
function backfillAnalyticsReadPermission(db: Database.Database) {
  db.prepare(
    `insert or ignore into admin_permissions (user_id, permission)
     select user_id, 'analytics_read' from admin_permissions
     where permission = 'analytics_run_retry'`,
  ).run();
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

// AR-002's local stand-in for the "approved Babysteps domain registry"
// precondition — production/staging origins must resolve under one of
// these suffixes (business rule 6). The fake deployment provider's
// generated origins deliberately end in "example.dev" so staging/
// production validation has something real to check against without a
// live Vercel account.
const APPROVED_DOMAIN_SUFFIXES = ["babysteps.in", "vercel.app", "example.dev"] as const;

function syncApprovedDomains(db: Database.Database) {
  const upsert = db.prepare(
    `insert into approved_domains (id, domain_suffix, status) values (?, ?, 'active')
     on conflict(domain_suffix) do update set status = 'active'`,
  );
  const sync = db.transaction(() => {
    for (const suffix of APPROVED_DOMAIN_SUFFIXES) {
      upsert.run(randomUUID(), suffix);
    }
  });
  sync();
}

function syncProductCatalog(db: Database.Database) {
  const upsert = db.prepare(
    `insert into products (id, slug, name, subdomain, razorpay_plan_id, price_inr, product_type, version, status)
     values (@id, @slug, @name, @subdomain, @razorpayPlanId, @priceInr, @productType, @version, @status)
     on conflict(slug) do update set
       name = excluded.name,
       subdomain = excluded.subdomain,
       price_inr = excluded.price_inr,
       product_type = excluded.product_type,
       version = excluded.version,
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
        productType: p.productType,
        version: p.version,
        status: p.status,
      });
    }
    // Products removed from CATALOG are archived, not deleted — a
    // subscription row's product_id may still reference them.
    archiveRemoved.run(...CATALOG.map((p) => p.slug));
  });
  sync();
}

function syncProductPrices(db: Database.Database) {
  const insert = db.prepare(
    `insert or ignore into product_prices(id,product_id,currency,billing_interval,interval_count,unit_amount,
     pricing_rule_version,supports_non_renewing,status,effective_from,version)
     select ?,id,'INR','month',1,price_inr*100,?,1,'active',datetime('now'),version
     from products where slug=?`,
  );
  const sync = db.transaction(() => {
    for (const product of CATALOG) {
      const row = db.prepare("select id,version from products where slug=?").get(product.slug) as
        { id: string; version: number };
      insert.run(`price:${row.id}:INR:month:v${row.version}`, `catalog-v${row.version}`, product.slug);
    }
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
      "analytics_read",
      "analytics_run_retry",
      "deployment_manage",
      "app_deployment_bind",
      "app_deployment_promote",
      "app_availability_read",
      "app_availability_manage",
      "subscription_reassignment_manage",
      "entitlement_security_revoke",
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
