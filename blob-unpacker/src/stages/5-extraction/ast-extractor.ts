// ============================================================
// STAGE 5 — AST-BASED EXTRACTOR
// Precision extraction using Babel AST parsing.
// Complements the regex-based extractors with higher accuracy:
//   - fetch/axios/XHR call arguments (exact URL extraction)
//   - Object properties with config-like keys
//   - Template literal URL construction
//   - Conditional/gated endpoint detection
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import * as t from "@babel/types";
import { DiscoveredEndpoint, DiscoveredConfig, ConfidenceLevel } from "../../types/contracts";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";

export interface AstExtractionResult {
  endpoints: DiscoveredEndpoint[];
  configs: DiscoveredConfig[];
}

// HTTP client method names
const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "head", "options", "request"]);
const HTTP_CLIENTS = new Set(["fetch", "axios", "$http", "http", "request", "superagent"]);

// Config-like key names
const CONFIG_KEYS = new Set([
  "apiUrl", "apiURL", "baseUrl", "baseURL", "apiKey", "apikey",
  "endpoint", "apiEndpoint", "serverUrl", "serverURL",
  "authUrl", "authURL", "loginUrl", "redirectUrl", "callbackUrl",
  "webhookUrl", "wsUrl", "socketUrl", "graphqlUrl", "graphqlEndpoint",
  "cdnUrl", "cdnURL", "uploadUrl", "downloadUrl",
  "clientId", "clientSecret", "appId", "appKey",
  "projectId", "tenantId", "orgId",
  "region", "bucket", "domain", "namespace",
  "sentryDsn", "dsn",
  "analyticsId", "trackingId", "measurementId",
]);

export function extractViaAst(
  code: string,
  sourceFile: string
): AstExtractionResult {
  const endpoints: DiscoveredEndpoint[] = [];
  const configs: DiscoveredConfig[] = [];

  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript", "dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
      errorRecovery: true,
    });
  } catch {
    return { endpoints, configs };
  }

  const lines = code.split("\n");

  try {
    traverse(ast, {
      // ── fetch(url), axios.get(url), etc. ─────────────────────
      CallExpression(path) {
        const callee = path.node.callee;
        const args = path.node.arguments;
        if (args.length === 0) return;

        let method: HttpMethod | undefined;
        let isFetchLike = false;

        // Direct function calls: fetch("url")
        if (t.isIdentifier(callee) && HTTP_CLIENTS.has(callee.name)) {
          isFetchLike = true;
        }

        // Method calls: axios.get("url"), $http.post("url")
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
          const propName = callee.property.name;

          // axios.get, http.post, etc.
          if (HTTP_METHODS.has(propName)) {
            isFetchLike = true;
            method = propName.toUpperCase() as HttpMethod;
          }

          // fetch-like objects: apiClient.get, httpService.post
          if (
            t.isIdentifier(callee.object) &&
            /(?:api|http|fetch|client|service|request)/i.test(callee.object.name) &&
            HTTP_METHODS.has(propName)
          ) {
            isFetchLike = true;
            method = propName.toUpperCase() as HttpMethod;
          }
        }

        if (!isFetchLike) return;

        // Extract the URL from the first argument
        const firstArg = args[0];
        let urlValue: string | null = null;

        if (t.isStringLiteral(firstArg)) {
          urlValue = firstArg.value;
        } else if (t.isTemplateLiteral(firstArg)) {
          // Reconstruct template literal with placeholders
          urlValue = reconstructTemplate(firstArg);
        }

        if (urlValue && (urlValue.startsWith("/") || urlValue.startsWith("http"))) {
          const line = path.node.loc?.start.line ?? 0;
          endpoints.push({
            value: urlValue,
            method,
            confidence: "high",
            source_file: sourceFile,
            line,
            context_snippet: getContext(lines, line),
          });
        }
      },

      // ── Object properties with config-like keys ──────────────
      ObjectProperty(path) {
        const key = path.node.key;
        let keyName: string | null = null;

        if (t.isIdentifier(key)) keyName = key.name;
        else if (t.isStringLiteral(key)) keyName = key.value;

        if (!keyName || !CONFIG_KEYS.has(keyName)) return;

        const value = path.node.value;
        let stringValue: string | null = null;

        if (t.isStringLiteral(value)) {
          stringValue = value.value;
        } else if (t.isTemplateLiteral(value) && value.expressions.length === 0) {
          stringValue = value.quasis[0]?.value.cooked ?? null;
        }

        if (stringValue && stringValue.length >= 2) {
          const line = path.node.loc?.start.line ?? 0;
          configs.push({
            key: keyName,
            value: stringValue,
            source_file: sourceFile,
            line,
          });

          // Also add as endpoint if it looks like a URL
          if (stringValue.startsWith("/") || stringValue.startsWith("http")) {
            endpoints.push({
              value: stringValue,
              confidence: "medium",
              source_file: sourceFile,
              line,
              context_snippet: getContext(lines, line),
            });
          }
        }
      },

      // ── JSX Route components ─────────────────────────────────
      JSXOpeningElement(path) {
        const name = path.node.name;
        if (!t.isJSXIdentifier(name)) return;

        // React Router: <Route path="...">
        if (!/Route/i.test(name.name)) return;

        for (const attr of path.node.attributes) {
          if (!t.isJSXAttribute(attr)) continue;
          if (!t.isJSXIdentifier(attr.name) || attr.name.name !== "path") continue;

          if (t.isStringLiteral(attr.value)) {
            const line = path.node.loc?.start.line ?? 0;
            endpoints.push({
              value: attr.value.value,
              confidence: "high",
              source_file: sourceFile,
              line,
              context_snippet: getContext(lines, line),
            });
          }
        }
      },
    });
  } catch {
    // AST traversal failed — return what we have
  }

  return { endpoints, configs };
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function reconstructTemplate(tl: t.TemplateLiteral): string {
  let result = "";
  for (let i = 0; i < tl.quasis.length; i++) {
    result += tl.quasis[i].value.cooked ?? "";
    if (i < tl.expressions.length) {
      result += "${...}"; // placeholder for dynamic parts
    }
  }
  return result;
}

function getContext(lines: string[], lineNum: number): string {
  const start = Math.max(0, lineNum - 3);
  const end = Math.min(lines.length - 1, lineNum + 2);
  return lines.slice(start, end + 1).join("\n");
}
