// ============================================================
// BLOB UNPACKER — ASSET CLASSIFIER
// Determines AssetType from URL patterns and content signals.
// Classification drives queue priority.
// ============================================================

import { AssetType } from "../../types/contracts";

// URL pattern matchers — order matters (most specific first)
const VENDOR_PATTERNS = [
  /vendor/i,
  /node_modules/i,
  /jquery/i,
  /react\./i,
  /react-dom/i,
  /lodash/i,
  /moment/i,
  /bootstrap/i,
  /polyfill/i,
  /webpack-runtime/i,
  /runtime\.[a-f0-9]+\.js$/i,
];

const MAIN_BUNDLE_PATTERNS = [
  /\bmain\b/i,
  /\bapp\b/i,
  /\bindex\b/i,
  /\bbundle\b/i,
];

const CHUNK_PATTERNS = [
  /chunk/i,
  /\.\d+\.[a-f0-9]+\.js$/i,   // e.g. 42.3f9a1b.js
  /\.[a-f0-9]{8,}\.js$/i,     // hash-named files that aren't main
];

export function classifyAsset(url: string, isInline = false): AssetType {
  if (isInline) return "inline";

  // Strip query string for matching
  const path = url.split("?")[0];

  if (VENDOR_PATTERNS.some((p) => p.test(path))) return "vendor";
  if (MAIN_BUNDLE_PATTERNS.some((p) => p.test(path))) return "main_bundle";
  if (CHUNK_PATTERNS.some((p) => p.test(path))) return "chunk";

  // Default: if it ends in .js, treat as chunk; otherwise unknown
  return path.endsWith(".js") ? "chunk" : "unknown";
}

/**
 * Content-based signal: is this actually JavaScript?
 * Rejects HTML error pages and redirects served as 200.
 */
export function isJavaScript(body: string, contentType?: string): boolean {
  const trimmed = body.trimStart();

  // Always sniff — Content-Type is a hint, not authority (servers often lie)
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML")) {
    return false;
  }
  if (contentType?.includes("text/html")) return false;

  const jsSignals = [
    /\bfunction\b/,
    /\bvar\b|\blet\b|\bconst\b/,
    /\bimport\b|\bexport\b/,
    /\brequire\s*\(/,
    /\bmodule\b/,
    /=>/,
  ];
  const looksLikeJs = jsSignals.some((p) => p.test(trimmed.slice(0, 2000)));

  if (contentType?.includes("javascript") || contentType?.includes("ecmascript")) {
    // CT claims JS — still require at least one signal or non-empty non-HTML body
    return looksLikeJs || (trimmed.length > 0 && !trimmed.startsWith("<"));
  }

  return looksLikeJs;
}
