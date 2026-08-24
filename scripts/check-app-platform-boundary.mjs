import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_EXTENSIONS = new Set([
  ".cjs", ".env", ".js", ".jsx", ".mjs", ".py", ".ts", ".tsx",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".next", "__pycache__", "coverage", "node_modules", "test-results", "work",
]);
const PLATFORM_TABLES = [
  "account_events", "admin_permissions", "app_deployment_launch_controls",
  "app_service_principals", "app_session_grants", "authorization_actions",
  "authorization_policy_active", "authorization_policy_bundles", "consent_records",
  "learner_app_progress", "learner_app_week_usage", "learner_session_credits",
  "learner_sessions", "learners", "lesson_completions", "payments", "profiles",
  "subscriptions", "technical_credit_claim_requests",
];

const RULES = [
  {
    name: "platform_service_credential",
    pattern: /\b(?:BABYSTEPS_(?:SUPABASE_)?SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY)\b/i,
  },
  {
    name: "generic_service_credential",
    pattern: /\bSUPABASE_SERVICE_KEY\b/i,
  },
  {
    name: "direct_database_credential",
    pattern: /\b(?:DATABASE_URL|POSTGRES(?:QL)?_URL|PGHOST|PGPASSWORD)\b|postgres(?:ql)?:\/\//i,
  },
  {
    name: "platform_database_client",
    pattern: /(?:@supabase\/supabase-js|@supabase\/ssr|\bpostgres\b|\bpg\b)[\s\S]*?BABYSTEPS_SUPABASE|BABYSTEPS_SUPABASE[\s\S]*?(?:createClient|Pool|Client)/i,
  },
  {
    name: "platform_table_access",
    pattern: new RegExp(`\\.(?:from|table)\\(\\s*["'](?:${PLATFORM_TABLES.join("|")})["']`, "i"),
  },
  {
    name: "platform_database_function",
    pattern: /\.rpc\(\s*["'][a-z0-9_]+["']/i,
  },
  {
    name: "platform_auth_administration",
    pattern: /\.auth\.admin\b/i,
  },
  {
    name: "browser_exposed_platform_credential",
    pattern: /\bNEXT_PUBLIC_[A-Z0-9_]*(?:SERVICE|SECRET|PRIVATE|DATABASE|POSTGRES|SUPABASE|TOKEN|PASSWORD)[A-Z0-9_]*\b/i,
  },
  {
    name: "platform_internal_dependency",
    pattern: /(?:from\s*|require\(\s*)["'](?:@\/|\.\.\/)+(?:src\/)?(?:lib|app\/v1)\//i,
  },
  {
    name: "direct_platform_network_access",
    pattern: /https?:\/\/(?:[a-z0-9-]+\.supabase\.co|(?:localhost|127\.0\.0\.1)(?::\d+)?)(?:\/|["'])|\/(?:rest|auth)\/v1\b/i,
  },
];

function normalized(relativePath) {
  return relativePath.replaceAll("\\", "/");
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

function isScannable(file) {
  const name = path.basename(file);
  return SOURCE_EXTENSIONS.has(path.extname(file)) || name.startsWith(".env");
}

function isAllowed(relativePath, rule, allowlist) {
  return allowlist.some((entry) => entry.path === relativePath && entry.rules.includes(rule));
}

export function scanApplicationBoundary(root, allowlist) {
  const appsDirectory = path.join(root, "apps");
  const violations = [];
  for (const file of filesBelow(appsDirectory).filter(isScannable)) {
    const relativePath = normalized(path.relative(root, file));
    const contents = fs.readFileSync(file, "utf8");
    for (const rule of RULES) {
      if (rule.pattern.test(contents) && !isAllowed(relativePath, rule.name, allowlist)) {
        violations.push({ path: relativePath, rule: rule.name });
      }
    }
  }
  return violations;
}

export function validateBoundaryAllowlist(root, allowlist, now = new Date()) {
  const errors = [];
  const knownRules = new Set(RULES.map((rule) => rule.name));
  for (const entry of allowlist) {
    if (/[*?\[\]]/.test(entry.path)) errors.push({ code: "ALLOWLIST_WILDCARD", path: entry.path });
    if (!fs.existsSync(path.join(root, entry.path))) errors.push({ code: "ALLOWLIST_PATH_MISSING", path: entry.path });
    if (!entry.owner?.trim() || !entry.reason?.trim()) errors.push({ code: "ALLOWLIST_JUSTIFICATION_MISSING", path: entry.path });
    if (!entry.rules?.length || entry.rules.some((rule) => !knownRules.has(rule))) {
      errors.push({ code: "ALLOWLIST_RULE_INVALID", path: entry.path });
    }
    const expiry = new Date(`${entry.expiresOn}T23:59:59.999Z`);
    if (!entry.expiresOn || Number.isNaN(expiry.valueOf()) || now > expiry) {
      errors.push({ code: "ALLOWLIST_EXPIRED", path: entry.path });
    }
  }
  return errors;
}

export function loadBoundaryAllowlist(root) {
  const file = path.join(root, "architecture", "app-platform-boundary-allowlist.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const allowlist = loadBoundaryAllowlist(root);
  const allowlistErrors = validateBoundaryAllowlist(root, allowlist);
  const violations = scanApplicationBoundary(root, allowlist);
  for (const issue of [...allowlistErrors, ...violations]) console.error(JSON.stringify(issue));
  if (allowlistErrors.length || violations.length) process.exit(1);
  console.log(`Application/platform boundary passed (${allowlist.length} reviewed app-owned exceptions).`);
}
