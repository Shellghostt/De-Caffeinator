// ============================================================
// BLOB UNPACKER — PATH HELPERS
// Centralizes per-website subfolder resolution so that every
// output stage writes into:
//
//   <outDir>/<hostname>/deobfuscated/   ← beautified JS
//   <outDir>/<hostname>/sources/        ← source-map reconstructed files
//   <outDir>/<hostname>/raw/            ← original downloaded JS (optional)
//   <outDir>/<hostname>/endpoints.json
//   <outDir>/<hostname>/secrets.json
//   <outDir>/<hostname>/comments.json
//   <outDir>/<hostname>/configs.json
//   <outDir>/<hostname>/summary.md
//   <outDir>/<hostname>/run-report.json
//   <outDir>/<hostname>/manifests/
// ============================================================

import * as path from "path";

/**
 * Given a JS asset URL and the pipeline base output directory,
 * return the per-hostname subdirectory path.
 *
 * Examples:
 *   https://thesunitagroup.in/_next/static/chunks/main.js  →  <outDir>/thesunitagroup.in
 *   inline://https://reddit.com#abc123                     →  <outDir>/reddit.com
 *   https://cdn.example.com:8080/js/app.js                 →  <outDir>/cdn.example.com
 */
export function getHostDir(assetUrl: string, baseOutDir: string): string {
  const hostname = extractHostname(assetUrl);
  return path.join(baseOutDir, hostname);
}

/**
 * Safe hostname extractor that handles:
 *   - Normal https:// URLs
 *   - inline:// synthetic URLs
 *   - Malformed / non-URL strings (falls back to "_unknown")
 */
export function extractHostname(url: string): string {
  // Handle inline:// synthetic URLs like inline://https://reddit.com#hash
  if (url.startsWith("inline://")) {
    const inner = url.slice("inline://".length);
    // inner may be "https://reddit.com#abc" or just "reddit.com#abc"
    const withScheme = inner.startsWith("http") ? inner : `https://${inner}`;
    try {
      const u = new URL(withScheme);
      return sanitizeHostname(u.hostname);
    } catch {
      // fall through
    }
  }

  try {
    const u = new URL(url);
    return sanitizeHostname(u.hostname);
  } catch {
    return "_unknown";
  }
}

/**
 * Make a hostname safe for use as a directory name on all platforms.
 * Strips port, lowercases, replaces anything non-alphanumeric/dot/hyphen.
 */
function sanitizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, "_") // keep dots and hyphens, replace rest
    .replace(/^\.+|\.+$/g, "")      // strip leading/trailing dots
    .slice(0, 100)                   // guard against extremely long hostnames
    || "_unknown";
}
