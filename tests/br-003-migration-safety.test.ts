import { describe, expect, it } from "vitest";
import { OVERRIDE_MARKER, checkMigrationDirectory, checkMigrationFile } from "../scripts/check-migration-safety.mjs";

describe("BR-003 checkMigrationFile", () => {
  it("flags a raw DROP TABLE statement", () => {
    expect(checkMigrationFile("drop table if exists foo;")).toContain("drop_table");
  });

  it("flags a raw DROP COLUMN statement", () => {
    expect(checkMigrationFile("alter table foo drop column bar;")).toContain("drop_column");
  });

  it("flags a RENAME COLUMN statement", () => {
    expect(checkMigrationFile("alter table foo rename column bar to baz;")).toContain("rename_column");
  });

  it("flags a table RENAME TO statement", () => {
    expect(checkMigrationFile("alter table foo rename to bar;")).toContain("rename_table");
  });

  it("flags an ALTER COLUMN ... TYPE statement", () => {
    expect(checkMigrationFile("alter table foo alter column bar type text;")).toContain("alter_column_type");
  });

  it("ignores a pattern inside a SQL comment", () => {
    expect(checkMigrationFile("-- drop table foo;\nselect 1;")).toEqual([]);
  });

  it("is silent for an ordinary additive migration", () => {
    expect(checkMigrationFile("alter table foo add column bar text;\ncreate table baz (id text primary key);")).toEqual([]);
  });

  it("is exempted entirely when the override marker is present, even alongside a real drop", () => {
    expect(checkMigrationFile(`${OVERRIDE_MARKER}\ndrop table if exists foo;`)).toEqual([]);
  });

  it("reports every distinct unsafe pattern present, not just the first", () => {
    const findings = checkMigrationFile("drop table foo;\nalter table bar drop column baz;");
    expect(findings).toEqual(expect.arrayContaining(["drop_table", "drop_column"]));
  });
});

describe("BR-003 checkMigrationDirectory — real repo state", () => {
  it("every checked-in migration is either safe or carries the reviewed-breaking-change marker", () => {
    expect(checkMigrationDirectory(process.cwd())).toEqual([]);
  });
});
