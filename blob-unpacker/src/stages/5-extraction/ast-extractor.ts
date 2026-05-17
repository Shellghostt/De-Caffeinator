// ============================================================
// STAGE 5 — AST-BASED EXTRACTOR (Acorn-powered)
// Precision extraction using Acorn AST parsing + acorn-walk.
// Complements the regex-based extractors with higher accuracy:
//   - fetch/axios/XHR call arguments (exact URL extraction)
//   - Object properties with config-like keys
//   - Template literal URL construction
//   - Route component path detection
// ============================================================

import * as acorn from "acorn";
import * as walk from "acorn-walk";
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

  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
      allowHashBang: true,
      // Acorn records locations by default when loc isn't explicitly false
      locations: true,
    });
  } catch {
    // If module parse fails, try script mode
    try {
      ast = acorn.parse(code, {
        ecmaVersion: 2022,
        sourceType: "script",
        allowHashBang: true,
        locations: true,
      });
    } catch {
      return { endpoints, configs };
    }
  }

  const lines = code.split("\n");

  try {
    walk.simple(ast, {
      // ── fetch(url), axios.get(url), etc. ─────────────────────
      CallExpression(node: any) {
        const callee = node.callee;
        const args = node.arguments;
        if (!args || args.length === 0) return;

        let method: HttpMethod | undefined;
        let isFetchLike = false;

        // Direct function calls: fetch("url")
        if (callee.type === "Identifier" && HTTP_CLIENTS.has(callee.name)) {
          isFetchLike = true;
        }

        // Method calls: axios.get("url"), $http.post("url")
        if (callee.type === "MemberExpression" && callee.property) {
          const propName = callee.property.name || callee.property.value;

          // axios.get, http.post, etc.
          if (propName && HTTP_METHODS.has(propName)) {
            isFetchLike = true;
            method = propName.toUpperCase() as HttpMethod;
          }

          // fetch-like objects: apiClient.get, httpService.post
          if (
            callee.object &&
            callee.object.type === "Identifier" &&
            /(?:api|http|fetch|client|service|request)/i.test(callee.object.name) &&
            propName &&
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

        if (firstArg.type === "Literal" && typeof firstArg.value === "string") {
          urlValue = firstArg.value;
        } else if (firstArg.type === "TemplateLiteral") {
          urlValue = reconstructTemplate(firstArg);
        }

        if (urlValue && (urlValue.startsWith("/") || urlValue.startsWith("http"))) {
          const line = node.loc?.start?.line ?? 0;
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
      Property(node: any) {
        const key = node.key;
        let keyName: string | null = null;

        if (key.type === "Identifier") keyName = key.name;
        else if (key.type === "Literal" && typeof key.value === "string") keyName = key.value;

        if (!keyName || !CONFIG_KEYS.has(keyName)) return;

        const value = node.value;
        let stringValue: string | null = null;

        if (value.type === "Literal" && typeof value.value === "string") {
          stringValue = value.value;
        } else if (
          value.type === "TemplateLiteral" &&
          value.expressions.length === 0 &&
          value.quasis.length > 0
        ) {
          stringValue = value.quasis[0]?.value?.cooked ?? null;
        }

        if (stringValue && stringValue.length >= 2) {
          const line = node.loc?.start?.line ?? 0;
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

      // ── Variable assignments with URL-like strings ───────────
      VariableDeclarator(node: any) {
        if (!node.id || !node.init) return;
        const idName = node.id.name;
        const init = node.init;

        if (!idName || init.type !== "Literal" || typeof init.value !== "string") return;

        const val = init.value;

        // Detect URL-like variable assignments
        if (val.startsWith("/api") || val.startsWith("/v1") || val.startsWith("/v2") || val.startsWith("http")) {
          const line = node.loc?.start?.line ?? 0;
          endpoints.push({
            value: val,
            confidence: "medium",
            source_file: sourceFile,
            line,
            context_snippet: getContext(lines, line),
          });
        }

        // Detect config-like variable names
        if (CONFIG_KEYS.has(idName) && val.length >= 2) {
          const line = node.loc?.start?.line ?? 0;
          configs.push({
            key: idName,
            value: val,
            source_file: sourceFile,
            line,
          });
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

function reconstructTemplate(tl: any): string {
  let result = "";
  const quasis = tl.quasis || [];
  const expressions = tl.expressions || [];
  for (let i = 0; i < quasis.length; i++) {
    result += quasis[i].value?.cooked ?? "";
    if (i < expressions.length) {
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
