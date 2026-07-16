import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const root = "/Users/sager/Documents/GitHub/Japan-Train-Map";
const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load(
    path.join(
      root,
      "outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/全表融合_行程_JSON纠正版_2026-07.xlsx",
    ),
  ),
);
const outputDir = path.join(
  root,
  "outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/workbook-edit/target-previews",
);
await fs.mkdir(outputDir, { recursive: true });

const targets = [
  ["融合总表", "A76:AA83", "fusion"],
  ["JSON对照", "A76:J83", "json-crosscheck"],
  ["大大纵贯路线_大大纵贯路线", "A111:P118", "itinerary"],
  ["全程列车总表_7.4-7.24_全程列车总表", "A73:M80", "master"],
  ["大大纵贯路线_核查总结", "A1:B3", "audit-summary"],
];

for (const [sheetName, range, fileName] of targets) {
  const preview = await workbook.render({
    sheetName,
    range,
    scale: 2,
    format: "png",
  });
  await fs.writeFile(
    path.join(outputDir, `${fileName}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}
