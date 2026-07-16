import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const root = "/Users/sager/Documents/GitHub/Japan-Train-Map";
const workbookPath = path.join(
  root,
  "全表融合_行程_JSON纠正版_2026-07.xlsx",
);
const previewDir = path.join(
  root,
  "outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/workbook-edit/previews-before",
);

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load(workbookPath),
);

console.log(
  (
    await workbook.inspect({
      kind: "workbook,sheet,table",
      maxChars: 12000,
      tableMaxRows: 8,
      tableMaxCols: 16,
      tableMaxCellChars: 100,
    })
  ).ndjson,
);

for (const term of ["西11丁目", "さっぽろ", "15:04", "15:35"]) {
  console.log(`MATCH ${term}`);
  console.log(
    (
      await workbook.inspect({
        kind: "match",
        searchTerm: term,
        options: { maxResults: 100 },
        maxChars: 12000,
      })
    ).ndjson,
  );
}

await fs.mkdir(previewDir, { recursive: true });
const sheetInfo = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 12000,
});
const sheetRecords = sheetInfo.ndjson
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((record) => record.kind === "sheet");

for (const sheet of sheetRecords) {
  const preview = await workbook.render({
    sheetName: sheet.name,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  const safeName = sheet.name.replaceAll("/", "_");
  await fs.writeFile(
    path.join(previewDir, `${safeName}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
  console.log(`RENDERED ${sheet.name}`);
}
