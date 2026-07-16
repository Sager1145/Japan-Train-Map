import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const previewDir =
  "/Users/sager/Documents/GitHub/Japan-Train-Map/outputs/019f6a98-0499-7fa2-a954-80cc138d6d7d/workbook-edit/previews-after";
const outputDir = path.join(previewDir, "contact");
await fs.mkdir(outputDir, { recursive: true });

const files = (await fs.readdir(previewDir))
  .filter((name) => name.endsWith(".png"))
  .sort();
const thumbWidth = 620;
const thumbHeight = 430;
const labelHeight = 42;
const tileHeight = thumbHeight + labelHeight;
const columns = 2;
const rows = 3;
const perPage = columns * rows;

for (let page = 0; page * perPage < files.length; page += 1) {
  const pageFiles = files.slice(page * perPage, (page + 1) * perPage);
  const composites = [];
  for (let index = 0; index < pageFiles.length; index += 1) {
    const name = pageFiles[index];
    const left = (index % columns) * thumbWidth;
    const top = Math.floor(index / columns) * tileHeight;
    const image = await sharp(path.join(previewDir, name))
      .resize(thumbWidth, thumbHeight, {
        fit: "contain",
        background: "#ffffff",
      })
      .png()
      .toBuffer();
    const label = await sharp({
      text: {
        text: name,
        font: "Arial",
        width: thumbWidth - 20,
        height: labelHeight,
        align: "center",
        rgba: true,
      },
    })
      .png()
      .toBuffer();
    composites.push({ input: image, left, top });
    composites.push({ input: label, left, top: top + thumbHeight });
  }
  await sharp({
    create: {
      width: thumbWidth * columns,
      height: tileHeight * rows,
      channels: 4,
      background: "#f3f4f6",
    },
  })
    .composite(composites)
    .png()
    .toFile(path.join(outputDir, `contact-${page + 1}.png`));
}
