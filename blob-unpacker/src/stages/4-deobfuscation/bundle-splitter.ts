// ============================================================
// STAGE 4 — BUNDLE DETECTOR & SPLITTER (Enhanced)
// Detects and unpacks bundles from multiple bundlers:
//   - Webpack 4 & 5 (array and object module registries)
//   - Rollup (flat IIFE with module markers)
//   - Vite (Rollup-based with ESM wrapper)
//   - Turbopack (Next.js)
//   - Parcel (runtime with module registry)
//
// For each detected format, extracts individual modules as
// separate named units with their dependency references.
// ============================================================

import { WebpackModule } from "../../types/contracts";
import { beautifyJs } from "./beautifier";

// ----------------------------------------------------------
// DETECTION PATTERNS
// ----------------------------------------------------------

// Webpack 4: (window.webpackJsonp = window.webpackJsonp || []).push(...)
const WEBPACK4_JSONP_RE = /(?:window|self|globalThis)(?:\["webpackJsonp[^"]*"\]|\.webpackJsonp\w*)\s*=.*?\.push\s*\(\s*\[\s*\[/;

// Webpack 5: self["webpackChunk..."] or __webpack_modules__
const WEBPACK5_CHUNK_RE = /(?:self|window|globalThis)\["webpackChunk[^"]*"\]/;
const WEBPACK5_MODULES_RE = /__webpack_modules__/;

// Webpack generic
const WEBPACK_REQUIRE_RE = /__webpack_require__/;

// Turbopack
const TURBOPACK_RE = /globalThis\.__turbopack_external__|__turbopack_require__|TURBOPACK/;

// Rollup marker: individual module IIFEs or named exports
const ROLLUP_MARKER_RE = /\/\*\*\s*@license|\bObject\.defineProperty\s*\(\s*exports/;

// Parcel runtime
const PARCEL_RE = /parcelRequire\s*=|__parcel__require__/;

// Module array form: ([function(e,t,n){...}, function(e,t,n){...}])
const MODULE_ARRAY_RE = /\(\s*\[\s*(function\s*\([^)]*\)\s*\{[\s\S]*?)\]\s*\)/;

// Module object form: ({0: function(e,t,n){...}, ...})
const MODULE_OBJECT_RE = /\(\s*\{\s*(\d+|["'][^"']+["'])\s*:\s*function/;

export type BundlerType = "webpack4" | "webpack5" | "turbopack" | "rollup" | "parcel" | "unknown";

export interface BundleSplitResult {
  isBundled: boolean;
  bundler: BundlerType;
  modules: WebpackModule[];
}

export function splitBundle(code: string): BundleSplitResult {
  const bundler = detectBundler(code);
  if (bundler === "unknown") {
    return { isBundled: false, bundler, modules: [] };
  }

  const modules = extractModules(code, bundler);
  return { isBundled: modules.length > 0, bundler, modules };
}

// ----------------------------------------------------------
// BUNDLER DETECTION
// ----------------------------------------------------------

function detectBundler(code: string): BundlerType {
  // Check first 10KB for signatures
  const head = code.slice(0, 10000);

  if (TURBOPACK_RE.test(head)) return "turbopack";
  if (WEBPACK4_JSONP_RE.test(head)) return "webpack4";
  if (WEBPACK5_CHUNK_RE.test(head) || WEBPACK5_MODULES_RE.test(head)) return "webpack5";
  if (WEBPACK_REQUIRE_RE.test(head) || MODULE_ARRAY_RE.test(head) || MODULE_OBJECT_RE.test(head)) {
    return "webpack4"; // generic webpack
  }
  if (PARCEL_RE.test(head)) return "parcel";
  if (ROLLUP_MARKER_RE.test(head)) return "rollup";

  return "unknown";
}

// ----------------------------------------------------------
// MODULE EXTRACTION
// ----------------------------------------------------------

function extractModules(code: string, bundler: BundlerType): WebpackModule[] {
  switch (bundler) {
    case "webpack4":
    case "webpack5":
      return extractWebpackModules(code);
    case "turbopack":
      return extractTurbopackModules(code);
    case "rollup":
      return extractRollupModules(code);
    case "parcel":
      return extractParcelModules(code);
    default:
      return [];
  }
}

// ----------------------------------------------------------
// WEBPACK MODULE EXTRACTION
// ----------------------------------------------------------

function extractWebpackModules(code: string): WebpackModule[] {
  const modules: WebpackModule[] = [];

  // Match individual module function bodies using a balanced-brace scanner
  // Pattern: numeric or string key followed by a function definition
  const MODULE_ENTRY_RE =
    /["']?(\d+|[a-zA-Z0-9_\-./]+)["']?\s*:\s*(function\s*\([^)]*\)\s*\{)/g;

  let match: RegExpExecArray | null;
  const positions: Array<{ id: string; bodyStart: number }> = [];

  while ((match = MODULE_ENTRY_RE.exec(code)) !== null) {
    positions.push({
      id: match[1],
      bodyStart: match.index + match[0].length - 1, // points to opening {
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const { id, bodyStart } = positions[i];
    const bodyEnd =
      i + 1 < positions.length
        ? findPrevFunctionEnd(code, positions[i + 1].bodyStart)
        : findClosingBrace(code, bodyStart);

    if (bodyEnd === -1) continue;

    const rawBody = code.slice(bodyStart, bodyEnd + 1);
    // Skip very small modules (likely boilerplate)
    if (rawBody.length < 20) continue;

    modules.push({
      id,
      content: beautifyJs(rawBody),
    });
  }

  return modules;
}

// ----------------------------------------------------------
// TURBOPACK MODULE EXTRACTION
// ----------------------------------------------------------

function extractTurbopackModules(code: string): WebpackModule[] {
  const modules: WebpackModule[] = [];

  // Turbopack pattern: { "[project]/src/file.ts [app-client] (ecmascript)": (...)  => { ... } }
  const TURBO_MODULE_RE =
    /\["([^"]+)"\]\s*(?::\s*\(|(?:\([^)]*\))\s*=>)\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = TURBO_MODULE_RE.exec(code)) !== null) {
    const id = match[1];
    const braceStart = code.indexOf("{", match.index + match[0].length - 1);
    if (braceStart === -1) continue;

    const braceEnd = findClosingBrace(code, braceStart);
    if (braceEnd === -1) continue;

    const rawBody = code.slice(braceStart, braceEnd + 1);
    if (rawBody.length < 20) continue;

    modules.push({
      id: cleanTurbopackId(id),
      content: beautifyJs(rawBody),
    });
  }

  return modules;
}

function cleanTurbopackId(id: string): string {
  // "[project]/src/app.tsx [app-client] (ecmascript)" → "src/app.tsx"
  return id
    .replace(/^\[project\]\//, "")
    .replace(/\s*\[.*?\]\s*/g, "")
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
}

// ----------------------------------------------------------
// ROLLUP MODULE EXTRACTION
// ----------------------------------------------------------

function extractRollupModules(code: string): WebpackModule[] {
  const modules: WebpackModule[] = [];

  // Rollup outputs named functions or variable declarations for each module
  // Look for function declarations that look like module wrappers
  const ROLLUP_FN_RE = /function\s+([a-zA-Z_$][\w$]*)\s*\(\s*\)\s*\{/g;

  let match: RegExpExecArray | null;
  let moduleIdx = 0;

  while ((match = ROLLUP_FN_RE.exec(code)) !== null) {
    const name = match[1];
    const braceStart = code.indexOf("{", match.index + match[0].length - 1);
    if (braceStart === -1) continue;

    const braceEnd = findClosingBrace(code, braceStart);
    if (braceEnd === -1) continue;

    const rawBody = code.slice(braceStart, braceEnd + 1);
    if (rawBody.length < 50) continue;

    modules.push({
      id: name,
      content: beautifyJs(rawBody),
    });
    moduleIdx++;
  }

  return modules;
}

// ----------------------------------------------------------
// PARCEL MODULE EXTRACTION
// ----------------------------------------------------------

function extractParcelModules(code: string): WebpackModule[] {
  const modules: WebpackModule[] = [];

  // Parcel pattern: parcelRequire.register("moduleId", function(...)  { ... })
  const PARCEL_MODULE_RE =
    /(?:parcelRequire\.register|__parcel__require__\.register)\s*\(\s*["']([^"']+)["']\s*,\s*function\s*\([^)]*\)\s*\{/g;

  let match: RegExpExecArray | null;
  while ((match = PARCEL_MODULE_RE.exec(code)) !== null) {
    const id = match[1];
    const braceStart = code.lastIndexOf("{", match.index + match[0].length);
    if (braceStart === -1) continue;

    const braceEnd = findClosingBrace(code, braceStart);
    if (braceEnd === -1) continue;

    const rawBody = code.slice(braceStart, braceEnd + 1);
    if (rawBody.length < 20) continue;

    modules.push({
      id,
      content: beautifyJs(rawBody),
    });
  }

  return modules;
}

// ----------------------------------------------------------
// SHARED UTILITIES
// ----------------------------------------------------------

/** Find the closing brace of a block, respecting nesting and string literals */
function findClosingBrace(code: string, openPos: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = openPos; i < code.length; i++) {
    const ch = code[i];

    // Handle string literals to avoid counting braces inside strings
    if (inString) {
      if (ch === inString && code[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }

    // Skip single-line comments
    if (ch === "/" && code[i + 1] === "/") {
      const newline = code.indexOf("\n", i + 2);
      if (newline !== -1) i = newline;
      continue;
    }
    // Skip multi-line comments
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end !== -1) i = end + 1;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findPrevFunctionEnd(code: string, nextStart: number): number {
  for (let i = nextStart; i >= 0; i--) {
    if (code[i] === "}") return i;
  }
  return -1;
}
