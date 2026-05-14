// ============================================================
// STAGE 4 — WEBPACK SPLITTER
// Detects the Webpack module registry pattern and extracts
// each module as a named logical unit.
//
// Webpack wraps modules in one of two patterns:
//   Array form:  ([function(e,t,n){...}, function(e,t,n){...}])
//   Object form: ({0: function(e,t,n){...}, "abc": function(...)})
// ============================================================

import { WebpackModule } from "../../types/contracts";
import { beautifyJs } from "./beautifier";

// Matches the webpack bootstrap IIFE with module array/object
const WEBPACK_ARRAY_RE =
  /\(\s*\[\s*(function\s*\([^)]*\)\s*\{[\s\S]*?)\]\s*\)/;
const WEBPACK_OBJECT_RE =
  /\(\s*\{\s*(\d+|["'][^"']+["'])\s*:\s*function/;

export interface WebpackSplitResult {
  isWebpack: boolean;
  modules: WebpackModule[];
}

export function splitWebpackBundle(code: string): WebpackSplitResult {
  const isWebpack = isWebpackBundle(code);
  if (!isWebpack) return { isWebpack: false, modules: [] };

  const modules = extractModules(code);
  return { isWebpack: true, modules };
}

function isWebpackBundle(code: string): boolean {
  return (
    // Common webpack runtime signals
    (code.includes("__webpack_require__") ||
      code.includes("webpackJsonp") ||
      code.includes("__webpack_modules__") ||
      WEBPACK_ARRAY_RE.test(code.slice(0, 5000)) ||
      WEBPACK_OBJECT_RE.test(code.slice(0, 5000)))
  );
}

function extractModules(code: string): WebpackModule[] {
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
    modules.push({
      id,
      content: beautifyJs(rawBody),
    });
  }

  return modules;
}

/** Find the closing brace of a block, respecting nesting */
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

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findPrevFunctionEnd(code: string, nextStart: number): number {
  // Walk backwards from next module start to find the closing brace + comma
  for (let i = nextStart; i >= 0; i--) {
    if (code[i] === "}") return i;
  }
  return -1;
}
