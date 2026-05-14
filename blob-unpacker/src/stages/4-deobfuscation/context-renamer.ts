// ============================================================
// STAGE 4 — CONTEXT-BASED VARIABLE RENAMER
//
// Infers meaningful names for minified single-letter variables
// by analyzing how they are used in the code. For example:
//
//   n.createElement("div")      → n is probably "document"
//   n.getElementById("app")     → n is probably "document"
//   n.querySelector(".btn")     → n is probably "document" or "element"
//   n.addEventListener("click") → n is probably an element
//   n.href                      → n is probably "location" or an anchor
//   n.pathname                  → n is probably "location"
//   n.push(...)                 → n is probably an array
//   n.stringify(...)            → n is probably "JSON"
//   n.parse(...)                → n is probably "JSON"
//   n.log(...)                  → n is probably "console"
//
// This is heuristic-based and only renames when confidence is
// high enough (multiple signals agree on the same identity).
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export interface ContextRenameResult {
  code: string;
  renamed: boolean;
  renameCount: number;
}

// Each rule maps a set of property accesses / method calls to a likely identity
interface ContextRule {
  /** The inferred name to rename to */
  inferredName: string;
  /** Method calls that suggest this identity (e.g., createElement, getElementById) */
  methods: string[];
  /** Property accesses that suggest this identity (e.g., href, pathname) */
  properties: string[];
  /** Minimum number of distinct signals before we rename */
  minSignals: number;
}

const CONTEXT_RULES: ContextRule[] = [
  {
    inferredName: "document",
    methods: [
      "createElement",
      "createElementNS",
      "createTextNode",
      "createDocumentFragment",
      "getElementById",
      "getElementsByClassName",
      "getElementsByTagName",
      "querySelector",
      "querySelectorAll",
      "createEvent",
      "createRange",
      "createComment",
      "createAttribute",
      "write",
      "writeln",
      "adoptNode",
      "importNode",
    ],
    properties: [
      "body",
      "head",
      "documentElement",
      "cookie",
      "domain",
      "referrer",
      "readyState",
      "title",
      "URL",
      "characterSet",
      "contentType",
      "doctype",
      "forms",
      "images",
      "links",
      "scripts",
      "styleSheets",
      "activeElement",
    ],
    minSignals: 2,
  },
  {
    inferredName: "window",
    methods: [
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "getComputedStyle",
      "matchMedia",
      "open",
      "close",
      "postMessage",
      "alert",
      "confirm",
      "prompt",
      "scroll",
      "scrollTo",
      "scrollBy",
      "resizeTo",
      "resizeBy",
      "moveTo",
      "moveBy",
    ],
    properties: [
      "innerWidth",
      "innerHeight",
      "outerWidth",
      "outerHeight",
      "pageXOffset",
      "pageYOffset",
      "scrollX",
      "scrollY",
      "screenX",
      "screenY",
      "devicePixelRatio",
      "location",
      "navigator",
      "history",
      "screen",
      "performance",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "crypto",
      "frames",
      "parent",
      "top",
      "self",
      "origin",
    ],
    minSignals: 2,
  },
  {
    inferredName: "console",
    methods: [
      "log",
      "warn",
      "error",
      "info",
      "debug",
      "trace",
      "dir",
      "table",
      "time",
      "timeEnd",
      "group",
      "groupEnd",
      "count",
      "assert",
      "clear",
    ],
    properties: [],
    minSignals: 2,
  },
  {
    inferredName: "JSON",
    methods: ["parse", "stringify"],
    properties: [],
    minSignals: 2,
  },
  {
    inferredName: "Math",
    methods: [
      "floor",
      "ceil",
      "round",
      "random",
      "abs",
      "max",
      "min",
      "pow",
      "sqrt",
      "log",
      "sin",
      "cos",
      "tan",
      "atan2",
      "sign",
      "trunc",
      "cbrt",
      "hypot",
      "clz32",
      "fround",
      "imul",
    ],
    properties: ["PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT2", "SQRT1_2"],
    minSignals: 2,
  },
  {
    inferredName: "Object",
    methods: [
      "keys",
      "values",
      "entries",
      "assign",
      "create",
      "defineProperty",
      "defineProperties",
      "freeze",
      "seal",
      "getOwnPropertyNames",
      "getOwnPropertyDescriptor",
      "getPrototypeOf",
      "setPrototypeOf",
      "is",
      "fromEntries",
      "hasOwn",
    ],
    properties: [],
    minSignals: 2,
  },
  {
    inferredName: "Array",
    methods: ["isArray", "from", "of"],
    properties: [],
    minSignals: 2,
  },
  {
    inferredName: "Promise",
    methods: ["resolve", "reject", "all", "allSettled", "any", "race"],
    properties: [],
    minSignals: 2,
  },
  {
    inferredName: "navigator",
    methods: ["sendBeacon", "vibrate", "share"],
    properties: [
      "userAgent",
      "language",
      "languages",
      "platform",
      "vendor",
      "cookieEnabled",
      "onLine",
      "hardwareConcurrency",
      "maxTouchPoints",
      "serviceWorker",
      "geolocation",
      "permissions",
      "mediaDevices",
      "connection",
      "clipboard",
      "credentials",
      "locks",
      "storage",
    ],
    minSignals: 2,
  },
  {
    inferredName: "location",
    methods: ["assign", "replace", "reload"],
    properties: [
      "href",
      "hostname",
      "pathname",
      "search",
      "hash",
      "port",
      "protocol",
      "host",
      "origin",
    ],
    minSignals: 2,
  },
  {
    inferredName: "history",
    methods: ["pushState", "replaceState", "back", "forward", "go"],
    properties: ["state", "length", "scrollRestoration"],
    minSignals: 2,
  },
  {
    inferredName: "localStorage",
    methods: ["getItem", "setItem", "removeItem", "clear"],
    properties: ["length"],
    minSignals: 3, // Higher threshold — getItem/setItem is common
  },
];

export function contextRename(code: string): ContextRenameResult {
  let ast: t.File;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["jsx", "typescript", "dynamicImport"],
    });
  } catch {
    return { code, renamed: false, renameCount: 0 };
  }

  // Phase 1: Collect signals for each single-letter binding
  //   key = binding name, value = Map<inferredName, signalCount>
  const signals = new Map<string, Map<string, number>>();

  traverse(ast, {
    MemberExpression(path) {
      const obj = path.node.object;
      const prop = path.node.property;

      // We only care about simple identifier.property patterns
      if (!t.isIdentifier(obj)) return;
      if (path.node.computed) return;
      if (!t.isIdentifier(prop)) return;

      const varName = obj.name;
      // Only target short (likely minified) variable names
      if (varName.length > 2) return;

      const propName = prop.name;

      // Check if this property/method matches any rule
      for (const rule of CONTEXT_RULES) {
        const isMethod = rule.methods.includes(propName);
        const isProp = rule.properties.includes(propName);
        if (!isMethod && !isProp) continue;

        if (!signals.has(varName)) {
          signals.set(varName, new Map<string, number>());
        }
        const varSignals = signals.get(varName)!;
        const current = varSignals.get(rule.inferredName) || 0;
        varSignals.set(rule.inferredName, current + 1);
      }
    },
  });

  // Phase 2: Decide which variables to rename
  //   Only rename if the top signal meets the minSignals threshold
  const renameMap = new Map<string, string>();

  for (const [varName, varSignals] of signals) {
    // Find the rule with the most signals
    let bestName = "";
    let bestCount = 0;

    for (const [inferredName, count] of varSignals) {
      if (count > bestCount) {
        bestCount = count;
        bestName = inferredName;
      }
    }

    if (!bestName) continue;

    // Check against the rule's threshold
    const rule = CONTEXT_RULES.find((r) => r.inferredName === bestName);
    if (!rule) continue;
    if (bestCount < rule.minSignals) continue;

    // Don't rename if the inferred name is already taken in scope
    // (we'll check this during the rename pass)
    renameMap.set(varName, bestName);
  }

  if (renameMap.size === 0) {
    return { code, renamed: false, renameCount: 0 };
  }

  // Phase 3: Apply renames via scope-aware traversal
  let totalRenames = 0;

  traverse(ast, {
    Identifier(path) {
      const name = path.node.name;
      if (!renameMap.has(name)) return;

      const newName = renameMap.get(name)!;

      // Don't rename property keys in non-computed member expressions
      if (
        t.isMemberExpression(path.parent) &&
        path.parent.property === path.node &&
        !path.parent.computed
      ) {
        return;
      }

      // Don't rename object property keys
      if (
        t.isObjectProperty(path.parent) &&
        path.parent.key === path.node &&
        !path.parent.computed
      ) {
        return;
      }

      // Check if this specific binding would conflict
      const binding = path.scope.getBinding(name);
      if (binding) {
        // Make sure we're not renaming something that's already declared as the target name
        const existing = path.scope.getBinding(newName);
        if (existing && existing !== binding) return; // Would conflict
      }

      path.node.name = newName;
      totalRenames++;
    },
  });

  if (totalRenames === 0) {
    return { code, renamed: false, renameCount: 0 };
  }

  try {
    const output = generate(ast, { comments: true });
    return { code: output.code, renamed: true, renameCount: totalRenames };
  } catch {
    return { code, renamed: false, renameCount: 0 };
  }
}
