import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const root = "/Users/sager/Documents/GitHub/Japan-Train-Map";
const sourcePath = path.join(
  root,
  "全表融合_行程_JSON纠正版_2026-07.xlsx",
);
const outputPath = path.join(
  root,
  "outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/全表融合_行程_JSON纠正版_2026-07.xlsx",
);
const previewDir = path.join(
  root,
  "outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/workbook-edit/previews-after",
);

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load(sourcePath),
);

const updates = [
  ["融合总表", "F81", "14:57"],
  ["融合总表", "H81", "14:59"],
  [
    "融合总表",
    "W81",
    "官方工作日时刻：西11丁目14:57发，14:59到大通",
  ],
  ["融合总表", "F82", "15:07"],
  ["融合总表", "H82", "15:09"],
  [
    "融合总表",
    "W82",
    "官方工作日时刻：大通15:07发，15:09到さっぽろ",
  ],
  ["JSON对照", "F81", "14:57"],
  ["JSON对照", "H81", "14:59"],
  ["JSON对照", "F82", "15:07"],
  ["JSON对照", "H82", "15:09"],
  ["大大纵贯路线_大大纵贯路线", "B116", "14:57"],
  ["大大纵贯路线_大大纵贯路线", "C116", "14:59"],
  [
    "大大纵贯路线_大大纵贯路线",
    "P116",
    "工作日官方时刻：西11丁目14:57发，大通14:59到",
  ],
  ["大大纵贯路线_大大纵贯路线", "B117", "15:07"],
  ["大大纵贯路线_大大纵贯路线", "C117", "15:09"],
  [
    "大大纵贯路线_大大纵贯路线",
    "P117",
    "工作日官方时刻：大通15:07发，さっぽろ15:09到",
  ],
  [
    "大大纵贯路线_核查总结",
    "B2",
    "7.16札幌市内交通已按工作日官方时刻修正：南北线さっぽろ11:30→すすきの11:33、大通13:30→中島公園13:33；市电内回り中島公園通14:02→すすきの14:13，下一班すすきの14:21→中央区役所前14:27；东西线西11丁目14:57→大通14:59；南北线大通15:07→さっぽろ15:09。JR官方无17:51发北斗，改为北斗20号(札幌16:51→函馆20:39)。7.24改线核对：南風20号、徳島线普通、うずしお28号、マリンライナー64号与官方时刻一致；さくら772号已修正为冈山22:18发→新大阪23:18到。",
  ],
  ["全程列车总表_7.4-7.24_全程列车总表", "C78", "14:57"],
  ["全程列车总表_7.4-7.24_全程列车总表", "E78", "14:59"],
  ["全程列车总表_7.4-7.24_全程列车总表", "C79", "15:07"],
  ["全程列车总表_7.4-7.24_全程列车总表", "E79", "15:09"],
];

for (const [sheetName, address, value] of updates) {
  workbook.worksheets.getItem(sheetName).getRange(address).values = [[value]];
}

const checks = [
  ["融合总表", "E81:H82"],
  ["JSON对照", "E81:H82"],
  ["大大纵贯路线_大大纵贯路线", "B116:P117"],
  ["大大纵贯路线_核查总结", "B1:B3"],
  ["全程列车总表_7.4-7.24_全程列车总表", "B78:E79"],
];

for (const [sheetId, range] of checks) {
  console.log(
    (
      await workbook.inspect({
        kind: "table",
        sheetId,
        range,
        include: "values,formulas",
        tableMaxRows: 10,
        tableMaxCols: 20,
        maxChars: 12000,
      })
    ).ndjson,
  );
}

console.log(
  (
    await workbook.inspect({
      kind: "match",
      searchTerm: "15:04|15:35|15:37",
      options: { useRegex: true, maxResults: 100 },
      summary: "superseded Sapporo timetable scan",
      maxChars: 12000,
    })
  ).ndjson,
);

console.log(
  (
    await workbook.inspect({
      kind: "match",
      searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
      options: { useRegex: true, maxResults: 300 },
      summary: "final formula error scan",
      maxChars: 12000,
    })
  ).ndjson,
);

await fs.mkdir(previewDir, { recursive: true });
const sheetInfo = await workbook.inspect({
  kind: "sheet",
  include: "id,name",
  maxChars: 12000,
});
const sheets = sheetInfo.ndjson
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((record) => record.kind === "sheet");

for (const sheet of sheets) {
  const preview = await workbook.render({
    sheetName: sheet.name,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  await fs.writeFile(
    path.join(previewDir, `${sheet.name.replaceAll("/", "_")}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);
const rootExport = await SpreadsheetFile.exportXlsx(workbook);
await rootExport.save(sourcePath);

console.log(`SAVED ${outputPath}`);
console.log(`SAVED ${sourcePath}`);
