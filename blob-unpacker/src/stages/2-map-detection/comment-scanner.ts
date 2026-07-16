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

  // ── Data URI: map is embedded inline ───────────────────────
  if (raw.startsWith("data:")) {
    const decoded = decodeDataUri(raw);
    if (decoded) {
      return { found: true, url: raw, isDataUri: true, embeddedContent: decoded };
    }
    return { found: false }; // malformed data URI
  }

  // ── Inline script guard ───────────────────────────────────
  // Inline scripts get a synthetic `inline://...` URL which is not a valid
  // HTTP base for resolving relative paths. A relative sourceMappingURL in an
  // inline script cannot be fetched, so discard it.
  // Absolute URLs (starting with http/https) in inline scripts are still valid.
  if (assetUrl.startsWith("inline://") && !raw.startsWith("http")) {
    return { found: false };
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
  // Prefer EOF-adjacent matches: scan only from last non-string region.
  // Heuristic: walk character-by-character tracking string state for the
  // line containing the match (handles escaped quotes better than parity counts).
  const lineStart = source.lastIndexOf("\n", matchIndex) + 1;
  const beforeMatch = source.slice(lineStart, matchIndex);

  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = 0; i < beforeMatch.length; i++) {
    const ch = beforeMatch[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && (inSingle || inDouble || inTemplate)) {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inTemplate = !inTemplate;
  }

  return inSingle || inDouble || inTemplate;
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
