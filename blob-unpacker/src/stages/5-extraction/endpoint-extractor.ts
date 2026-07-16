// ============================================================
// STAGE 5 — ENDPOINT EXTRACTOR (Enhanced)
// Extracts API endpoints, internal routes, hardcoded URLs,
// WebSocket URLs, and IP addresses using both regex-based
// (broad coverage) and structural pattern matching (precision).
//
// Classifies each endpoint:
//   - public:   normal user-facing routes
//   - internal: contains admin/internal/debug/staging keywords
//   - hidden:   exists in code but unreachable through normal UI
// ============================================================

import { DiscoveredEndpoint, ConfidenceLevel } from "../../types/contracts";
import { buildLineStarts, lineNumberAt } from "../../lib/line-index";

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
type EndpointClass = "public" | "internal" | "hidden";

interface RawEndpoint {
  value: string;
  method?: HttpMethod;
  confidence: ConfidenceLevel;
  line: number;
  context_snippet: string;
  classification: EndpointClass;
}

// ==============================================================
// PATTERN DEFINITIONS (externalized for easy tuning)
// ==============================================================

// ── HIGH CONFIDENCE: Direct API call patterns ────────────────
const HIGH_CONF_PATTERNS: RegExp[] = [
  // fetch() / axios.method() / $http.method()
  /(?:fetch|axios\.get|axios\.post|axios\.put|axios\.delete|axios\.patch|axios\.head|axios\.request)\s*\(\s*["'`](\/[^"'`\s]{2,})["'`]/g,
  /(?:fetch|axios\.get|axios\.post|axios\.put|axios\.delete|axios\.patch)\s*\(\s*["'`](https?:\/\/[^"'`\s]+)["'`]/g,
  /\$http\.\w+\s*\(\s*["'`](\/[^"'`\s]{2,})["'`]/g,

  // Generic .get/.post/.put/.delete/.patch with path args
  /(?:\.get|\.post|\.put|\.delete|\.patch)\s*\(\s*["'`](\/api\/[^"'`\s]+)["'`]/g,
  /(?:\.get|\.post|\.put|\.delete|\.patch)\s*\(\s*["'`](\/v\d+\/[^"'`\s]+)["'`]/g,

  // NOTE: XMLHttpRequest .open() is handled separately (method in group 1, URL in group 2)

  // url/baseURL/endpoint assignments
  /(?:url|baseURL|baseUrl|endpoint|apiUrl|apiEndpoint)\s*[:=]\s*["'`]((?:https?:\/\/|\/)[^"'`\s]{2,})["'`]/gi,

  // WebSocket URLs
  /["'`](wss?:\/\/[^"'`\s]+)["'`]/g,
];

// ── MEDIUM CONFIDENCE: String literals that look like API paths ──
const MED_CONF_PATTERNS: RegExp[] = [
  /["'`](\/api\/[^"'`\s]{3,})["'`]/g,
  /["'`](\/v\d+\/[^"'`\s]{3,})["'`]/g,
  /["'`](\/internal\/[^"'`\s]{3,})["'`]/g,
  /["'`](\/admin\/[^"'`\s]{3,})["'`]/g,
  /["'`](\/graphql[^"'`\s]*)["'`]/g,
  /["'`](\/debug\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/staging\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/test\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/auth\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/oauth\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/webhook[s]?\/[^"'`\s]{2,})["'`]/g,
  /["'`](\/socket\.io[^"'`\s]*)["'`]/g,
];

// ── LOW CONFIDENCE: Full URLs and IP addresses ────────────────
const LOW_CONF_PATTERNS: RegExp[] = [
  // Full URLs (including internal/staging domains)
  /["'`](https?:\/\/[a-zA-Z0-9][\w.-]{2,}(?::\d+)?\/[^"'`\s]{2,})["'`]/g,
  // Protocol-relative URLs
  /["'`](\/\/[a-zA-Z0-9][\w.-]{2,}(?::\d+)?\/[^"'`\s]{2,})["'`]/g,
  // IP addresses with ports
  /["'`](https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\/[^"'`\s]*)["'`]/g,
];

// ── FRONTEND ROUTE PATTERNS ──────────────────────────────────
const ROUTE_PATTERNS: RegExp[] = [
  // React Router: <Route path="/admin/users" ...>
  /(?:<Route|<PrivateRoute|<AuthRoute)\s+[^>]*path\s*=\s*["'`]([^"'`]+)["'`]/g,
  // Vue Router: { path: "/admin/users", ... }
  /path\s*:\s*["'`](\/[^"'`\s]{2,})["'`]/g,
  // Angular: { path: "admin/users", ... }
  /path\s*:\s*["'`]([^"'`\s]{2,})["'`]\s*,\s*(?:component|loadChildren|redirectTo)/g,
  // Next.js app directory patterns (from source map paths)
  /["'`](\/(?:app|pages)\/[^"'`\s]+)["'`]/g,
];

// ── TEMPLATE LITERAL PATHS ───────────────────────────────────
const TEMPLATE_PATH_RE = /`(\/(?:api|v\d+|internal|admin|auth|debug)\/${[^`]+})`/g;

// ── METHOD EXTRACTION ────────────────────────────────────────
const METHOD_HINT_RE = /\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i;

// ── NOISE FILTERS ────────────────────────────────────────────
const NOISE_RE = /\.(js|css|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|ico|map|ts|tsx|jsx|vue|scss|less)(['"`]|$)/i;
const NOISE_PATHS = new Set(["/", "//", "/*", "/.", "/..", "/undefined", "/null"]);

// ── INTERNAL ENDPOINT KEYWORDS ───────────────────────────────
const INTERNAL_KEYWORDS = /(?:internal|admin|debug|staging|test|private|hidden|backdoor|bypass|dev|preview|sandbox)/i;

export function extractEndpoints(
  code: string,
  sourceFile: string,
  extraPatterns: string[] = []
): DiscoveredEndpoint[] {
  const seen = new Set<string>();
  const results: RawEndpoint[] = [];
  const lines = code.split("\n");
  const lineStarts = buildLineStarts(code);

  const addResult = (value: string, confidence: ConfidenceLevel, matchIndex: number, contextOverride?: string) => {
    if (!value || NOISE_RE.test(value) || NOISE_PATHS.has(value)) return;
    if (value.length < 3 || value.length > 500) return;
    if (seen.has(value)) return;
    seen.add(value);

    const line = lineNumberAt(lineStarts, matchIndex);
    const context_snippet = contextOverride ?? getContext(lines, line);
    const method = extractMethod(context_snippet);
    const classification = classifyEndpoint(value, context_snippet);

    results.push({ value, method, confidence, line, context_snippet, classification });
  };

  // ── Run all pattern tiers ───────────────────────────────────
  runPatterns(code, HIGH_CONF_PATTERNS, "high", addResult);
  runPatterns(code, MED_CONF_PATTERNS, "medium", addResult);
  runPatterns(code, LOW_CONF_PATTERNS, "low", addResult);
  runPatterns(code, ROUTE_PATTERNS, "medium", addResult);

  // Custom operator patterns from config
  for (const raw of extraPatterns) {
    try {
      const re = new RegExp(raw, "g");
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        addResult(m[1] ?? m[0], "medium", m.index);
      }
    } catch {
      // invalid user regex — skip
    }
  }

  // ── Template literals ───────────────────────────────────────
  TEMPLATE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TEMPLATE_PATH_RE.exec(code)) !== null) {
    addResult(match[1], "medium", match.index);
  }

  // ── XHR open() — special handling (method in group 1, URL in group 2) ──
  const XHR_RE = /\.open\s*\(\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]\s*,\s*["'`]([^"'`\s]+)["'`]/gi;
  XHR_RE.lastIndex = 0;
  while ((match = XHR_RE.exec(code)) !== null) {
    const method = match[1].toUpperCase() as HttpMethod;
    const url = match[2];
    if (!seen.has(url) && !NOISE_RE.test(url)) {
      seen.add(url);
      const line = lineNumberAt(lineStarts, match.index);
      const context_snippet = getContext(lines, line);
      const classification = classifyEndpoint(url, context_snippet);
      results.push({ value: url, method, confidence: "high", line, context_snippet, classification });
    }
  }

  return results.map((r) => ({
    value: r.value,
    method: r.method,
    confidence: r.confidence,
    source_file: sourceFile,
    line: r.line,
    context_snippet: r.context_snippet,
    classification: r.classification,
  }));
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function runPatterns(
  code: string,
  patterns: RegExp[],
  confidence: ConfidenceLevel,
  addResult: (value: string, confidence: ConfidenceLevel, matchIndex: number) => void
) {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      // Always use group 1 — patterns are written with the URL in capture group 1.
      // The XHR pattern (.open) is handled separately below with explicit group indexing.
      const value = match[1];
      if (value) addResult(value, confidence, match.index);
    }
  }
}

function classifyEndpoint(value: string, context: string): EndpointClass {
  // Check the URL itself for internal keywords
  if (INTERNAL_KEYWORDS.test(value)) return "internal";

  // Check the surrounding context for conditional/hidden indicators
  if (/if\s*\(\s*(?:false|0|debug|isDev|isTest|__DEV__)/i.test(context)) return "hidden";
  if (/\/\*\s*(?:hidden|disabled|unreachable|deprecated)/i.test(context)) return "hidden";

  return "public";
}

function extractMethod(snippet: string): HttpMethod | undefined {
  const m = METHOD_HINT_RE.exec(snippet);
  if (!m) return undefined;
  const upper = m[1].toUpperCase();
  const valid: HttpMethod[] = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
  return valid.includes(upper as HttpMethod) ? (upper as HttpMethod) : undefined;
}

function getContext(lines: string[], lineNum: number): string {
  const start = Math.max(0, lineNum - 3);
  const end = Math.min(lines.length - 1, lineNum + 2);
  return lines.slice(start, end + 1).join("\n");
}
