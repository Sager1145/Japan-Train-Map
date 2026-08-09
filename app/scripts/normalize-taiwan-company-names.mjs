import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.resolve(SCRIPT_DIR, "..", "data", "train-store-tw.json");

const COMPANY_NAMES = new Map([
  ["國營臺灣鐵路股份有限公司", "台鐵"],
  ["臺灣鐵路股份有限公司", "台鐵"],
  ["台灣鐵路股份有限公司", "台鐵"],
  ["交通部臺灣鐵路管理局", "台鐵"],
  ["台灣高速鐵路股份有限公司", "台灣高鐵"],
  ["臺灣高速鐵路股份有限公司", "台灣高鐵"],
  ["臺北大眾捷運股份有限公司", "台北捷運"],
  ["台北大眾捷運股份有限公司", "台北捷運"],
  ["新北大眾捷運股份有限公司", "新北捷運"],
  ["桃園大眾捷運股份有限公司", "桃園捷運"],
  ["臺中捷運股份有限公司", "台中捷運"],
  ["台中捷運股份有限公司", "台中捷運"],
  ["高雄捷運股份有限公司", "高雄捷運"],
  ["阿里山林業鐵路及文化資產管理處", "阿里山林鐵"],
  ["農業部林業及自然保育署阿里山林業鐵路及文化資產管理處", "阿里山林鐵"],
]);

function normalizeCompany(value) {
  return String(value || "")
    .split("/")
    .map((name) => {
      const trimmed = name.trim();
      return COMPANY_NAMES.get(trimmed) || trimmed;
    })
    .filter(Boolean)
    .join("/");
}

const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
let changed = 0;
for (const train of store.trains || []) {
  const company = normalizeCompany(train.company);
  if (company === train.company) continue;
  train.company = company;
  changed += 1;
}

if (changed) {
  const temporary = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store)}\n`);
  fs.renameSync(temporary, STORE_FILE);
}

console.log(`Normalized ${changed} Taiwan company name${changed === 1 ? "" : "s"}.`);
