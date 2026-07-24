import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import globals from "globals";

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
const scriptNames = [...html.matchAll(/<script\s+src="([^"]+)"/g)]
  .map((match) => match[1].split(/[?#]/, 1)[0])
  .filter(
    (name) =>
      !name.includes("/") &&
      name.endsWith(".js") &&
      fs.existsSync(path.join(PUBLIC_DIR, name)),
  );

// These files are classic scripts sharing one browser global environment.
// Linting them one-by-one reports every legitimate cross-file reference as
// undefined; concatenating in the exact index.html order models the runtime
// scope and lets no-undef find only genuinely missing identifiers.
const locations = [];
let line = 1;
const source = scriptNames
  .map((name) => {
    const text = fs.readFileSync(path.join(PUBLIC_DIR, name), "utf8");
    const lines = text.split(/\r?\n/).length;
    locations.push({ name, start: line, end: line + lines - 1 });
    line += lines + 1;
    return `${text}\n`;
  })
  .join("\n");

const linter = new Linter();
const messages = linter.verify(source, {
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "script",
    globals: {
      ...globals.browser,
      ...globals.es2021,
      // Runtime globals created by UMD wrappers or vendor scripts that are
      // deliberately excluded from this first-party source pass.
      // `module` is only used behind a UMD `typeof module` guard by the two
      // browser/Node shared libraries; other Node globals remain forbidden.
      module: "readonly",
      AppCore: "readonly",
      I18N: "readonly",
      RailMap: "readonly",
      RailNetwork: "readonly",
      RailMapPopup: "readonly",
      maplibregl: "readonly",
      uiConfirm: "readonly",
      uiPrompt: "readonly",
    },
  },
  rules: {
    "no-undef": "error",
  },
});

const errors = messages.filter((message) => message.severity === 2);
if (errors.length) {
  for (const error of errors) {
    const location =
      locations.find(
        (item) => error.line >= item.start && error.line <= item.end,
      ) || locations.at(-1);
    const localLine = location
      ? Math.max(1, error.line - location.start + 1)
      : error.line;
    console.error(
      `${location?.name || "frontend"}:${localLine}:${error.column} ${error.message} (${error.ruleId})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Undefined-global check passed: ${scriptNames.length} ordered frontend scripts.`,
  );
}
