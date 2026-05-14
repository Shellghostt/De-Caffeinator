// ============================================================
// BLOB UNPACKER — PATH HELPERS
// Centralizes per-website subfolder resolution so that every
// output stage writes into a clean, target-centric layout:
//
//   <outDir>/<target-host>/
//     ├── deobfuscated/       ← first-party beautified JS
//     ├── sources/            ← first-party source-map files
//     ├── raw/                ← first-party original JS
//     ├── endpoints.json
//     ├── secrets.json
//     ├── comments.json
//     ├── configs.json
//     ├── summary.md
//     ├── run-report.json
//     ├── manifests/
//     └── third-party/
//         └── <hostname>/
//             ├── deobfuscated/
//             ├── sources/
//             └── raw/
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
 * Resolve the output directory for a specific asset, aware of
 * whether it's first-party (same host as target) or third-party.
 *
 * First-party assets go to:
 *   <outDir>/<target-host>/
 *
 * Third-party assets go to:
 *   <outDir>/<target-host>/third-party/<asset-host>/
 *
 * @param assetUrl     The URL of the JS asset being written
 * @param targetUrls   The target URLs from the pipeline config
 * @param baseOutDir   The root output directory
 */
export function getAssetDir(
  assetUrl: string,
  targetUrls: string[],
  baseOutDir: string
): string {
  const assetHost = extractHostname(assetUrl);
  const targetHost = extractTargetHostname(targetUrls);

  if (assetHost === targetHost || assetHost === "_unknown") {
    // First-party: write directly under the target folder
    return path.join(baseOutDir, targetHost);
  }

  // Third-party: nest under target/third-party/<hostname>
  return path.join(baseOutDir, targetHost, "third-party", assetHost);
}

/**
 * Extract the primary target hostname from the pipeline's target_urls.
 * Uses the first target URL; falls back to "_unknown".
 */
export function extractTargetHostname(targetUrls: string[]): string {
  if (targetUrls.length === 0) return "_unknown";
  return extractHostname(targetUrls[0]);
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
