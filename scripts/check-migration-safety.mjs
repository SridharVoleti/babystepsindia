import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// BR-003, AT-BR-003-02: "unsafe failed migration blocks release." Pattern-
// based (Automation tag on the acceptance test is "Automated/Review", not
// full semantic validation) — flags the DDL shapes most likely to break
// the "backward-compatible with the immediately previous app where
// practical" rule (a dropped/renamed column or table breaks any release
// still reading the old shape). A migration that genuinely needs one of
// these is still possible — add the exact literal override comment on its
// own line, which is itself a reviewable diff line making the tradeoff
// explicit, not a silent bypass.
export const OVERRIDE_MARKER = "-- BR-003: reviewed-breaking-change";

const UNSAFE_PATTERNS = [
  { name: "drop_table", pattern: /\bdrop\s+table\b/i },
  { name: "drop_column", pattern: /\bdrop\s+column\b/i },
  { name: "rename_column", pattern: /\brename\s+column\b/i },
  { name: "rename_table", pattern: /\brename\s+to\b/i },
  { name: "alter_column_type", pattern: /\balter\s+column\s+\S+\s+type\b/i },
];

function stripSqlComments(source) {
  return source.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
}

export function checkMigrationFile(source) {
  if (source.includes(OVERRIDE_MARKER)) return [];
  const withoutComments = stripSqlComments(source);
  return UNSAFE_PATTERNS.filter((rule) => rule.pattern.test(withoutComments)).map((rule) => rule.name);
}

export function checkMigrationDirectory(root) {
  const directory = path.join(root, "supabase", "migrations");
  if (!fs.existsSync(directory)) return [];
  const violations = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".sql")) continue;
    const file = path.join(directory, name);
    const findings = checkMigrationFile(fs.readFileSync(file, "utf8"));
    for (const rule of findings) violations.push({ file: name, rule });
  }
  return violations;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const violations = checkMigrationDirectory(process.cwd());
  for (const issue of violations) console.error(JSON.stringify(issue));
  if (violations.length) {
    console.error(
      `${violations.length} potentially unsafe migration statement(s) found. ` +
      `If reviewed and intentional, add the exact line "${OVERRIDE_MARKER}" to that file.`,
    );
    process.exit(1);
  }
  console.log("Migration safety check passed — no unreviewed drop/rename/type-change statements.");
}
