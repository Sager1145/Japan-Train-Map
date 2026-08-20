import fs from "node:fs";
import { Linter } from "eslint";
import {
  readOrderedAppScripts,
  resolveAppScript,
} from "../lib/app-family-sandbox.mjs";

const ROOT_SCRIPT = /^[^/]+\.js$/;
const GLOBAL_OBJECTS = new Set(["global", "globalThis", "self", "window"]);
const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "delete",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

function patternNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return patternNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return patternNames(pattern.left);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap(patternNames);
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      property.type === "RestElement"
        ? patternNames(property.argument)
        : patternNames(property.value),
    );
  }
  return [];
}

function memberRoot(node) {
  let current = node;
  while (current && current.type === "MemberExpression") current = current.object;
  return current && current.type === "Identifier" ? current.name : null;
}

function memberProperty(node) {
  if (!node || node.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.computed && node.property.type === "Literal") {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
}

function functionName(node) {
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  if (node.id && node.id.name) return node.id.name;
  const parent = node.parent;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (
    (parent?.type === "Property" || parent?.type === "MethodDefinition") &&
    !parent.computed
  ) {
    return parent.key.name || String(parent.key.value || "anonymous");
  }
  if (parent?.type === "AssignmentExpression") {
    return memberProperty(parent.left) || "assigned callback";
  }
  if (parent?.type === "CallExpression") {
    return `${memberProperty(parent.callee) || "call"} callback`;
  }
  return `anonymous@${node.loc.start.line}`;
}

function leadingPurpose(sourceCode, node, name) {
  const comments = sourceCode.getCommentsBefore(node);
  const text = comments.at(-1)?.value
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
    .find(Boolean);
  if (text && !/^[-─=]+$/.test(text)) return text;
  return name
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
}

function markdown(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function inspectScript(name) {
  const filename = resolveAppScript(name);
  const source = fs.readFileSync(filename, "utf8");
  const facts = {
    name,
    source,
    functions: [],
    mutable: [],
    unresolved: new Set(),
    dynamicGlobals: new Set(),
    exports: new Set(),
    calls: [],
    writes: [],
  };
  const functionStack = [];
  const functionByNode = new Map();

  const enterFunction = (node, sourceCode) => {
    const fnName = functionName(node);
    const fn = {
      name: fnName,
      line: node.loc.start.line,
      endLine: node.loc.end.line,
      purpose: leadingPurpose(sourceCode, node, fnName),
      calls: new Set(),
      dynamicCalls: new Set(),
      mutationRoots: new Set(),
      effects: new Set(),
      reads: new Set(),
      writes: new Set(),
      node,
    };
    facts.functions.push(fn);
    functionByNode.set(node, fn);
    functionStack.push(fn);
  };
  const leaveFunction = () => functionStack.pop();
  const currentFunction = () => functionStack.at(-1) || null;

  const inventoryRule = {
    create(context) {
      const sourceCode = context.sourceCode;
      return {
        Program(node) {
          for (const statement of node.body) {
            if (statement.type === "FunctionDeclaration" && statement.id) {
              facts.mutable.push({
                name: statement.id.name,
                kind: "function",
                line: statement.loc.start.line,
              });
            }
            if (statement.type !== "VariableDeclaration") continue;
            for (const declaration of statement.declarations) {
              for (const declaredName of patternNames(declaration.id)) {
                const mutableValue =
                  statement.kind !== "const" ||
                  [
                    "ArrayExpression",
                    "ObjectExpression",
                    "NewExpression",
                  ].includes(declaration.init?.type);
                if (mutableValue) {
                  facts.mutable.push({
                    name: declaredName,
                    kind: statement.kind,
                    line: declaration.loc.start.line,
                  });
                }
              }
            }
          }
        },
        "Program:exit"() {
          const globalScope = sourceCode.scopeManager.globalScope;
          for (const reference of globalScope?.through || []) {
            facts.unresolved.add(reference.identifier.name);
          }
          for (const fn of facts.functions) {
            const scope = sourceCode.scopeManager.acquire(fn.node);
            for (const reference of scope?.through || []) {
              const target = reference.identifier.name;
              if (reference.isWrite()) fn.writes.add(target);
              if (reference.isRead()) fn.reads.add(target);
            }
          }
        },
        FunctionDeclaration(node) {
          enterFunction(node, sourceCode);
        },
        "FunctionDeclaration:exit": leaveFunction,
        FunctionExpression(node) {
          enterFunction(node, sourceCode);
        },
        "FunctionExpression:exit": leaveFunction,
        ArrowFunctionExpression(node) {
          enterFunction(node, sourceCode);
        },
        "ArrowFunctionExpression:exit": leaveFunction,
        MemberExpression(node) {
          const root = memberRoot(node);
          const property = memberProperty(node);
          if (GLOBAL_OBJECTS.has(root) && property) {
            facts.dynamicGlobals.add(property);
          }
        },
        AssignmentExpression(node) {
          const target =
            node.left.type === "Identifier" ? node.left.name : memberRoot(node.left);
          if (target) {
            facts.writes.push({ target, line: node.loc.start.line });
            currentFunction()?.writes.add(target);
          }
          const root = memberRoot(node.left);
          const property = memberProperty(node.left);
          if (GLOBAL_OBJECTS.has(root) && property) facts.exports.add(property);
        },
        UpdateExpression(node) {
          const target =
            node.argument.type === "Identifier"
              ? node.argument.name
              : memberRoot(node.argument);
          if (target) {
            facts.writes.push({ target, line: node.loc.start.line });
            currentFunction()?.writes.add(target);
          }
        },
        CallExpression(node) {
          const fn = currentFunction();
          const direct = node.callee.type === "Identifier" ? node.callee.name : null;
          const root = memberRoot(node.callee);
          const property = memberProperty(node.callee);
          if (direct) fn?.calls.add(direct);
          if (GLOBAL_OBJECTS.has(root) && property) fn?.dynamicCalls.add(property);
          facts.calls.push({
            target: direct || property,
            dynamic: Boolean(!direct && GLOBAL_OBJECTS.has(root) && property),
            caller: fn?.name || "<top level>",
            line: node.loc.start.line,
          });
          if (root && property && MUTATING_METHODS.has(property)) {
            facts.writes.push({ target: root, line: node.loc.start.line });
            fn?.writes.add(root);
            fn?.mutationRoots.add(root);
          }
          const effectName = direct || property || "";
          if (direct === "fetch") fn?.effects.add("network");
          if (["setTimeout", "setInterval", "queueMicrotask"].includes(direct)) {
            fn?.effects.add("scheduling");
          }
          if (["localStorage", "indexedDB"].includes(root)) fn?.effects.add("storage");
          if (["document", "window"].includes(root)) fn?.effects.add("DOM/browser");
          if (root === "console") fn?.effects.add("logging");
          if (root === "map" || /^render|^update|^set.*Map/.test(effectName)) {
            fn?.effects.add("render/map");
          }
          if (
            root === "Object" &&
            property === "assign" &&
            node.arguments[0]?.type === "MemberExpression"
          ) {
            const exportRoot = memberRoot(node.arguments[0]);
            const exportName = memberProperty(node.arguments[0]);
            if (GLOBAL_OBJECTS.has(exportRoot) && exportName) {
              facts.exports.add(exportName);
            }
          }
        },
      };
    },
  };

  const linter = new Linter();
  const messages = linter.verify(source, [
    {
      files: ["**/*.js"],
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "script",
      },
      plugins: { inventory: { rules: { collect: inventoryRule } } },
      rules: { "inventory/collect": "error" },
    },
  ], { filename: name });
  const fatal = messages.find((message) => message.fatal);
  if (fatal) throw new Error(`${name}:${fatal.line}:${fatal.column} ${fatal.message}`);
  return facts;
}

const scriptNames = readOrderedAppScripts({
  filter: (src) => ROOT_SCRIPT.test(src.split(/[?#]/, 1)[0]),
});
const scripts = scriptNames.map(inspectScript);
const scriptByName = new Map(scripts.map((script) => [script.name, script]));
const owners = new Map();
const addOwner = (symbol, filename) => {
  if (!owners.has(symbol)) owners.set(symbol, new Set());
  owners.get(symbol).add(filename);
};
for (const script of scripts) {
  for (const declaration of script.mutable) addOwner(declaration.name, script.name);
  for (const exported of script.exports) addOwner(exported, script.name);
}

const dependencies = [];
for (const script of scripts) {
  const symbols = new Map();
  for (const symbol of new Set([
    ...script.unresolved,
    ...script.dynamicGlobals,
  ])) {
    for (const owner of owners.get(symbol) || []) {
      if (owner === script.name) continue;
      if (!symbols.has(owner)) symbols.set(owner, new Set());
      symbols.get(owner).add(symbol);
    }
  }
  for (const [owner, names] of symbols) {
    dependencies.push({
      from: script.name,
      to: owner,
      symbols: [...names].sort(),
    });
  }
}

const callsByTarget = new Map();
for (const script of scripts) {
  for (const call of script.calls) {
    if (!call.target) continue;
    if (!callsByTarget.has(call.target)) callsByTarget.set(call.target, []);
    callsByTarget.get(call.target).push({ file: script.name, ...call });
  }
}

const sharedMutable = [];
for (const script of scripts) {
  for (const declaration of script.mutable) {
    if (declaration.kind === "function") continue;
    const readers = [];
    const writers = [];
    for (const candidate of scripts) {
      if (candidate.unresolved.has(declaration.name)) readers.push(candidate.name);
      if (candidate.writes.some((write) => write.target === declaration.name)) {
        writers.push(candidate.name);
      }
    }
    sharedMutable.push({
      ...declaration,
      owner: script.name,
      readers: [...new Set(readers)].sort(),
      writers: [...new Set([script.name, ...writers])].sort(),
    });
  }
}

const functions = scripts
  .flatMap((script) =>
    script.functions.map((fn) => {
      const calls = callsByTarget.get(fn.name) || [];
      const directCallers = calls
        .filter((call) => !call.dynamic)
        .map((call) => `${call.file}:${call.line} ${call.caller}`);
      const dynamicCallers = calls
        .filter((call) => call.dynamic)
        .map((call) => `${call.file}:${call.line} ${call.caller}`);
      const exported = script.exports.has(fn.name);
      let deadCodeClass = "uncertain";
      if (dynamicCallers.length) deadCodeClass = "dynamically referenced";
      else if (exported) deadCodeClass = "compatibility surface";
      else if (directCallers.length) deadCodeClass = "reachable";
      return {
        ...fn,
        file: script.name,
        directCallers: [...new Set(directCallers)].sort(),
        dynamicCallers: [...new Set(dynamicCallers)].sort(),
        disposition: fn.endLine - fn.line + 1 >= 180 ? "split" : "keep",
        deadCodeClass,
      };
    }),
  )
  .sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );

const summary =
  `Inspected ${scripts.length} scripts, ${functions.length} functions, ` +
  `${dependencies.length} dependency edges, and ${sharedMutable.length} mutable bindings.`;

if (process.argv.includes("--summary")) {
  console.log(summary);
} else {
  console.log("# Frontend architecture inventory\n");
  console.log(
    "Deterministic static report. It follows the ordered classic scripts in " +
      "`public/index.html`; zero static callers is classified as `uncertain`, " +
      "never as proof that a symbol is dead.\n",
  );
  console.log("## Ordered classic scripts\n");
  scriptNames.forEach((name, index) => console.log(`${index + 1}. \`${name}\``));

console.log("\n## File-level dependency map\n");
console.log("| Consumer | Provider | Referenced symbols |");
console.log("|---|---|---|");
for (const edge of dependencies.sort((a, b) =>
  `${a.from}\0${a.to}`.localeCompare(`${b.from}\0${b.to}`),
)) {
  console.log(
    `| ${markdown(edge.from)} | ${markdown(edge.to)} | ${markdown(edge.symbols.join(", "))} |`,
  );
}

console.log("\n## Shared mutable bindings\n");
console.log("| Binding | Declaration | Readers outside owner | Files that write |");
console.log("|---|---|---|---|");
for (const state of sharedMutable.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(
    `| ${markdown(state.name)} | ${markdown(`${state.owner}:${state.line} (${state.kind})`)} | ` +
      `${markdown(state.readers.filter((name) => name !== state.owner).join(", ") || "—")} | ` +
      `${markdown(state.writers.join(", "))} |`,
  );
}

console.log("\n## Function inventory\n");
console.log(
  "| Declaration | Purpose | Direct callers | Dynamic callers | Shared state read | Shared state written | Side effects | Disposition | Reachability class |",
);
console.log("|---|---|---|---|---|---|---|---|---|");
const sharedNames = new Set(sharedMutable.map((state) => state.name));
  for (const fn of functions) {
  const reads = [...fn.reads].filter((name) => sharedNames.has(name)).sort();
  const writes = [...fn.writes].filter((name) => sharedNames.has(name)).sort();
  console.log(
    `| ${markdown(`${fn.file}:${fn.line} ${fn.name}`)} | ${markdown(fn.purpose)} | ` +
      `${markdown(fn.directCallers.join("; ") || "—")} | ` +
      `${markdown(fn.dynamicCallers.join("; ") || "—")} | ` +
      `${markdown(reads.join(", ") || "—")} | ${markdown(writes.join(", ") || "—")} | ` +
      `${markdown([...fn.effects].sort().join(", ") || "pure/unknown")} | ` +
      `${fn.disposition} | ${fn.deadCodeClass} |`,
  );
  }
}

if (!process.argv.includes("--summary")) console.error(summary);
