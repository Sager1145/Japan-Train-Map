import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbook = await SpreadsheetFile.importXlsx(
  await FileBlob.load(
    "/Users/sager/Documents/GitHub/Japan-Train-Map/全表融合_行程_JSON纠正版_2026-07.xlsx",
  ),
);

const targets = [
  ["融合总表", "A76:AA83"],
  ["JSON对照", "A76:J83"],
  ["大大纵贯路线_大大纵贯路线", "A111:P118"],
  ["大大纵贯路线_核查总结", "A1:B3"],
  ["全程列车总表_7.4-7.24_全程列车总表", "A73:M80"],
  ["jr_pass_2026_pass_outside_izu_3", "A14:M16"],
];

for (const [sheetId, range] of targets) {
  console.log(`TARGET ${sheetId}!${range}`);
  console.log(
    (
      await workbook.inspect({
        kind: "table",
        sheetId,
        range,
        include: "values,formulas",
        tableMaxRows: 20,
        tableMaxCols: 30,
        maxChars: 20000,
      })
    ).ndjson,
  );
  console.log(
    (
      await workbook.inspect({
        kind: "computedStyle",
        sheetId,
        range,
        maxChars: 5000,
      })
    ).ndjson,
  );
}
