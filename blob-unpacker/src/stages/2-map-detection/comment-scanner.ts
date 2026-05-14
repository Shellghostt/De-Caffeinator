// ============================================================
// STAGE 2 — COMMENT SCANNER (Enhanced)
// Detects sourceMappingURL in JS source.
// Handles:
//   - //# sourceMappingURL=<url>
//   - //@ sourceMappingURL=<url>   (legacy)
//   - /*# sourceMappingURL=<url> */  (multi-line variant)
//   - /*@ sourceMappingURL=<url> */
// Guards against false positives inside string literals.
// Handles relative paths, absolute URLs, and base64 data URIs.
// ============================================================

// Single-line: //# sourceMappingURL=<url> or //@ sourceMappingURL=<url>
const SINGLE_LINE_RE = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;

// Multi-line: /*# sourceMappingURL=<url> */ or /*@ sourceMappingURL=<url> */
const MULTI_LINE_RE = /\/\*[#@]\s*sourceMappingURL=([^\s*'"]+)\s*\*\//g;

// Patterns that indicate we're inside a string literal (false positive)
// e.g. "//# sourceMappingURL=" as a string value
const STRING_CONTEXT_RE = /['"]\s*\/\/[#@]\s*sourceMappingURL=/;
const TEMPLATE_CONTEXT_RE = /`[^`]*\/\/[#@]\s*sourceMappingURL=/;

export interface CommentScanResult {
  found: boolean;
  url?: string;
  isDataUri?: boolean;
  embeddedContent?: string; // decoded JSON if data URI
}

export function scanForMapComment(
  jsContent: string,
  assetUrl: string
): CommentScanResult {
  // Only scan the last 10KB — sourceMappingURL is always near the end
  // (increased from 5KB to handle minified files with long last lines)
  const tail = jsContent.slice(-10000);

  // Try to find all matches — use the LAST one (closest to EOF is most reliable)
  const candidates: string[] = [];

  // Single-line comments
  SINGLE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SINGLE_LINE_RE.exec(tail)) !== null) {
    if (!isInsideString(tail, m.index)) {
      candidates.push(m[1].trim());
    }
  }

  // Multi-line comments
  MULTI_LINE_RE.lastIndex = 0;
  while ((m = MULTI_LINE_RE.exec(tail)) !== null) {
    if (!isInsideString(tail, m.index)) {
      candidates.push(m[1].trim());
    }
  }

  if (candidates.length === 0) return { found: false };

  // Use the LAST candidate (most likely to be the real one)
  const raw = candidates[candidates.length - 1];

  // ── Data URI: map is embedded inline ─────────────────────
  if (raw.startsWith("data:")) {
    const decoded = decodeDataUri(raw);
    if (decoded) {
      return { found: true, url: raw, isDataUri: true, embeddedContent: decoded };
    }
    return { found: false }; // malformed data URI
  }

  // ── External URL: resolve relative to asset URL ───────────
  try {
    const resolved = new URL(raw, assetUrl).href;
    return { found: true, url: resolved, isDataUri: false };
  } catch {
    return { found: false };
  }
}

/**
 * Heuristic to detect if a match position is inside a string literal.
 * Counts unescaped quotes before the position — odd count means we're inside a string.
 */
function isInsideString(source: string, matchIndex: number): boolean {
  // Look at the line containing this match
  const lineStart = source.lastIndexOf("\n", matchIndex) + 1;
  const beforeMatch = source.slice(lineStart, matchIndex);

  // Count unescaped single quotes, double quotes, and backticks
  const singleQuotes = countUnescaped(beforeMatch, "'");
  const doubleQuotes = countUnescaped(beforeMatch, '"');
  const backticks = countUnescaped(beforeMatch, "`");

  // If any quote count is odd, we're likely inside a string
  return (singleQuotes % 2 !== 0) || (doubleQuotes % 2 !== 0) || (backticks % 2 !== 0);
}

function countUnescaped(text: string, char: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char && (i === 0 || text[i - 1] !== "\\")) {
      count++;
    }
  }
  return count;
}

function decodeDataUri(uri: string): string | null {
  // Expected: data:application/json;base64,<payload>
  // Or:       data:application/json;charset=utf-8,<payload>
  try {
    const commaIdx = uri.indexOf(",");
    if (commaIdx === -1) return null;

    const meta = uri.slice(0, commaIdx);
    const payload = uri.slice(commaIdx + 1);

    if (meta.includes("base64")) {
      return Buffer.from(payload, "base64").toString("utf-8");
    } else {
      return decodeURIComponent(payload);
    }
  } catch {
    return null;
  }
}
