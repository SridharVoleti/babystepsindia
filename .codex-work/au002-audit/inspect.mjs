import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const source = "D:/Sridhar/Projects/BabyStepsIndia/Requirements/Babysteps_Platform_Requirements_v18.xlsx";
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
const detail = await workbook.inspect({
  kind: "table",
  range: "02_Requirements!A23:AF24",
  include: "values,formulas",
  tableMaxRows: 4,
  tableMaxCols: 32,
  maxChars: 20000,
});
console.log(detail.ndjson);
const styles = await workbook.inspect({
  kind: "computedStyle",
  sheetId: "02_Requirements",
  range: "A23:AF24",
  maxChars: 4000,
});
console.log(styles.ndjson);
for (const searchTerm of ["AU-001", "Done"]) {
  const matches = await workbook.inspect({ kind: "match", searchTerm, options: { maxResults: 50 }, maxChars: 12000 });
  console.log(searchTerm, matches.ndjson);
}
const headers = await workbook.inspect({ kind: "table", range: "02_Requirements!A1:AF3", include: "values,formulas", tableMaxRows: 3, tableMaxCols: 32, maxChars: 12000 });
console.log(headers.ndjson);
const preview = await workbook.render({ sheetName: "02_Requirements", range: "A22:AF25", scale: 1, format: "png" });
await fs.writeFile("D:/Sridhar/Projects/BabyStepsIndia/.codex-work/au002-audit/before.png", new Uint8Array(await preview.arrayBuffer()));

if (process.argv.includes("--mark-done")) {
  workbook.worksheets.getItem("02_Requirements").getRange("I24").values = [["Done"]];
  const check = await workbook.inspect({ kind: "table", range: "02_Requirements!A24:I24", include: "values,formulas", tableMaxRows: 1, tableMaxCols: 9, maxChars: 3000 });
  console.log("UPDATED", check.ndjson);
  const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 300 }, maxChars: 3000 });
  console.log("ERRORS", errors.ndjson);
  const after = await workbook.render({ sheetName: "02_Requirements", range: "A22:J25", scale: 2, format: "png" });
  await fs.writeFile("D:/Sridhar/Projects/BabyStepsIndia/.codex-work/au002-audit/after.png", new Uint8Array(await after.arrayBuffer()));
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(source);
}
