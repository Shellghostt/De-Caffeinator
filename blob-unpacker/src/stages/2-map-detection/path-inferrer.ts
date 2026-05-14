// ============================================================
// STAGE 2 — PATH INFERRER (Enhanced)
// Heuristic: if no explicit map reference exists, probe common
// .map URL patterns using HEAD requests (no body download).
//
// Strategies:
//   A. Direct .map append:     app.js     → app.js.map
//   B. Extension swap:         app.js     → app.map
//   C. Directory-based probes: /sourcemaps/, /maps/, /.map/
//   D. Inferred naming:        main.es5.js → main.js.map
//                               app.min.js  → app.js.map
// ============================================================

import { PipelineContext } from "../../core/context";
import { headUrl } from "../../lib/http";

export interface InferResult {
  found: boolean;
  url?: string;
}

/**
 * Generate candidate map URLs from the asset URL.
 * Each function takes the asset URL and returns a candidate map URL,
 * or null if the pattern doesn't apply.
 */
const MAP_CANDIDATES: Array<(url: string) => string | null> = [
  // ── Strategy A: Direct .map append ────────────────────────
  (url) => `${url}.map`,                              // app.js → app.js.map

  // ── Strategy B: Extension swap ────────────────────────────
  (url) => url.endsWith(".js") ? url.replace(/\.js$/, ".map") : null,   // app.js → app.map

  // ── Strategy C: Directory-based probes ────────────────────
  // Try common map directories at the same level
  (url) => swapDirSegment(url, "sourcemaps"),          // /js/app.js → /sourcemaps/app.js.map
  (url) => swapDirSegment(url, "maps"),                // /js/app.js → /maps/app.js.map
  (url) => swapDirSegment(url, ".map"),                // /js/app.js → /.map/app.js.map

  // ── Strategy D: Inferred naming patterns ──────────────────
  // Build tools often add suffixes before .js — remove them
  (url) => url.includes(".min.js")
    ? url.replace(/\.min\.js$/, ".js.map")             // app.min.js → app.js.map
    : null,
  (url) => url.includes(".min.js")
    ? url.replace(/\.min\.js$/, ".min.js.map")         // app.min.js → app.min.js.map
    : null,
  (url) => /\.es[56]?\.js$/.test(url)
    ? url.replace(/\.es[56]?\.js$/, ".js.map")         // main.es5.js → main.js.map
    : null,
  (url) => /\.bundle\.js$/.test(url)
    ? url.replace(/\.bundle\.js$/, ".js.map")           // app.bundle.js → app.js.map
    : null,
  (url) => /\.bundle\.js$/.test(url)
    ? url.replace(/\.bundle\.js$/, ".bundle.js.map")    // app.bundle.js → app.bundle.js.map
    : null,
  // Hash-based: app.abc123.js → app.abc123.js.map (already covered by Strategy A)
  // But also try without hash: app.abc123.js → app.js.map
  (url) => {
    const m = url.match(/^(.+)\.[a-f0-9]{6,}\.js$/);
    return m ? `${m[1]}.js.map` : null;
  },
];

export async function inferMapPath(
  assetUrl: string,
  ctx: PipelineContext
): Promise<InferResult> {
  if (!ctx.config.map_detection.try_inferred_path) {
    return { found: false };
  }

  const probed = new Set<string>();

  for (const buildCandidate of MAP_CANDIDATES) {
    let candidate: string | null;
    try {
      candidate = buildCandidate(assetUrl);
      if (!candidate) continue;

      // Skip if it produces the same URL
      if (candidate === assetUrl) continue;

      // Skip duplicates (multiple strategies may produce the same URL)
      if (probed.has(candidate)) continue;
      probed.add(candidate);
    } catch {
      continue;
    }

    ctx.logger.debug(`Path inferrer: probing ${candidate}`, {
      stage: "stage-2",
      asset_url: assetUrl,
    });

    const { exists } = await headUrl(candidate, ctx);
    if (exists) {
      ctx.logger.info(`Path inferrer: found map at ${candidate}`, {
        stage: "stage-2",
        asset_url: assetUrl,
      });
      return { found: true, url: candidate };
    }
  }

  return { found: false };
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

/**
 * Replace the directory segment of a URL with a common map directory name.
 * e.g. https://cdn.example.com/js/app.js → https://cdn.example.com/sourcemaps/app.js.map
 */
function swapDirSegment(assetUrl: string, dirName: string): string | null {
  try {
    const u = new URL(assetUrl);
    const parts = u.pathname.split("/");
    const filename = parts[parts.length - 1];
    if (!filename || !filename.endsWith(".js")) return null;

    // Replace the last directory with the map directory
    parts[parts.length - 2] = dirName;
    parts[parts.length - 1] = filename + ".map";
    u.pathname = parts.join("/");
    return u.href;
  } catch {
    return null;
  }
}
