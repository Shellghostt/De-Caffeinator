// ============================================================
// STAGE 4 — IIFE PARAMETER ALIAS RESOLVER
//
// Detects patterns like:
//   (function(N, d, p, K) { ... })(window, document, location, setTimeout)
//
// And replaces all uses of N → window, d → document, p → location,
// K → setTimeout throughout the function body.
//
// This is the single most impactful de-minification transform
// because minifiers almost always alias globals this way.
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export interface IIFEResolveResult {
  code: string;
  resolved: boolean;
  aliasCount: number;
}

// Only resolve aliases for well-known global identifiers.
// This prevents unsafe renames of app-specific arguments.
const SAFE_GLOBALS = new Set([
  "window",
  "document",
  "location",
  "navigator",
  "console",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "Promise",
  "Symbol",
  "Array",
  "Object",
  "JSON",
  "Math",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "Reflect",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "undefined",
  "NaN",
  "Infinity",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "atob",
  "btoa",
  "fetch",
  "XMLHttpRequest",
  "FormData",
  "URLSearchParams",
  "URL",
  "Blob",
  "File",
  "FileReader",
  "AbortController",
  "Headers",
  "Request",
  "Response",
  "crypto",
  "performance",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "history",
  "screen",
  "alert",
  "confirm",
  "prompt",
  "open",
  "close",
  "postMessage",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "getComputedStyle",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "Node",
  "Element",
  "HTMLElement",
  "DocumentFragment",
  "globalThis",
  "self",
  "top",
  "parent",
  "frames",
  "Boolean",
  "Number",
  "String",
  "Function",
  "eval",
  "require",
  "module",
  "exports",
  "global",
  "process",
  "Buffer",
  "__dirname",
  "__filename",
]);

export function resolveIIFEAliases(code: string): IIFEResolveResult {
  let ast: t.File;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["jsx", "typescript", "dynamicImport"],
    });
  } catch {
    return { code, resolved: false, aliasCount: 0 };
  }

  let totalAliases = 0;

  traverse(ast, {
    // Match: (function(a, b, c) { ... })(window, document, location)
    CallExpression(path) {
      const callee = path.node.callee;

      // Must be a call to a function expression (IIFE)
      if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) return;

      const params = callee.params;
      const args = path.node.arguments;

      if (params.length === 0 || args.length === 0) return;

      // Build a map of param → argument value
      const aliasMap = new Map<string, string>();

      for (let i = 0; i < Math.min(params.length, args.length); i++) {
        const param = params[i];
        const arg = args[i];

        // param must be a simple Identifier
        if (!t.isIdentifier(param)) continue;

        // arg must be a simple Identifier that is a known global
        if (t.isIdentifier(arg) && SAFE_GLOBALS.has(arg.name)) {
          aliasMap.set(param.name, arg.name);
        }
        // Also handle member expressions like window.document
        else if (
          t.isMemberExpression(arg) &&
          !arg.computed &&
          t.isIdentifier(arg.object) &&
          t.isIdentifier(arg.property)
        ) {
          const fullName = `${arg.object.name}.${arg.property.name}`;
          // Only if the result is itself a known global
          if (SAFE_GLOBALS.has(arg.property.name)) {
            aliasMap.set(param.name, arg.property.name);
          } else {
            aliasMap.set(param.name, fullName);
          }
        }
      }

      if (aliasMap.size === 0) return;

      // Now traverse the function body and rename all references
      const funcPath = path.get("callee") as any;
      if (!funcPath || !funcPath.isFunction || !funcPath.isFunction()) return;

      const bodyPath = funcPath.get("body");
      if (!bodyPath) return;

      bodyPath.traverse({
        Identifier(idPath: any) {
          const name = idPath.node.name;
          if (!aliasMap.has(name)) return;

          // Don't rename the parameter declaration itself
          if (idPath.isBindingIdentifier()) {
            const binding = idPath.scope.getBinding(name);
            if (binding && binding.path === idPath) return;
          }

          // Don't rename if it's a property key (obj.N should not become obj.window)
          if (
            t.isMemberExpression(idPath.parent) &&
            idPath.parent.property === idPath.node &&
            !idPath.parent.computed
          ) {
            return;
          }

          // Don't rename if there's a local re-declaration shadowing the param
          const binding = idPath.scope.getBinding(name);
          if (binding) {
            // Check if the binding is from a different scope (re-declared locally)
            const paramBinding = funcPath.scope.getBinding(name);
            if (binding !== paramBinding) return;
          }

          idPath.node.name = aliasMap.get(name)!;
          totalAliases++;
        },
      });
    },
  });

  if (totalAliases === 0) {
    return { code, resolved: false, aliasCount: 0 };
  }

  try {
    const output = generate(ast, { comments: true });
    return { code: output.code, resolved: true, aliasCount: totalAliases };
  } catch {
    return { code, resolved: false, aliasCount: 0 };
  }
}
