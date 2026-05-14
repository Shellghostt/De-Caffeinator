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
  // Trust content-type if present
  if (contentType) {
    if (contentType.includes("javascript")) return true;
    if (contentType.includes("text/html")) return false;
  }

  // Fallback: sniff first non-whitespace characters
  const trimmed = body.trimStart();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) return false;

  // Must contain at least some JS-like tokens
  const jsSignals = [
    /\bfunction\b/,
    /\bvar\b|\blet\b|\bconst\b/,
    /\bimport\b|\bexport\b/,
    /\brequire\s*\(/,
    /\bmodule\b/,
    /=>/,
  ];
  return jsSignals.some((p) => p.test(trimmed.slice(0, 2000)));
}
