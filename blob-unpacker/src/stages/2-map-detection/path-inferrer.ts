// ============================================================
// STAGE 2 — PATH INFERRER (Enhanced)
// Heuristic: if no explicit map reference exists, probe common
// .map URL patterns using HEAD then GET fallback.
//
// Strategies:
//   A. Direct .map append:     app.js     → app.js.map
//   B. Extension swap:         app.js     → app.map
//   C. Directory-based probes: /sourcemaps/, /maps/, /.map/
//   D. Inferred naming:        main.es5.js → main.js.map
//                               app.min.js  → app.js.map
//
// Key behaviours (mirrored from Hellhound-Spider):
//   - Query strings are stripped before building candidates
//     (prevents malformed URLs like app.js?v=123.map)
//   - HEAD failures (405, 0, network) fall back to a GET probe
//     (some servers reject HEAD but serve the file on GET)
//   - GET responses are validated for source-map JSON markers
//     (rejects SPA catch-alls that return HTML or empty JSON)
// ============================================================

import { PipelineContext } from "../../core/context";
import { headUrl, fetchUrl } from "../../lib/http";

export interface InferResult {
  found: boolean;
  url?: string;
}

/**
 * Generate candidate map URLs from the asset URL.
 * Each function takes the asset URL and returns a candidate map URL,
 * or null if the pattern doesn't apply.
 */
/**
 * Strip query string and fragment from a URL, returning the bare path URL.
 * This is CRITICAL: without stripping, Strategy A produces
 *   https://cdn.example.com/app.js?v=abc123.map
 * instead of
 *   https://cdn.example.com/app.js.map
 * Mirrors Hellhound-Spider's `url.split('?')[0]` pre-processing.
 */
function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    // Not a valid absolute URL — fall back to simple split
    return url.split("?")[0].split("#")[0];
  }
}

const MAP_CANDIDATES: Array<(cleanUrl: string) => string | null> = [
  // ── Strategy A: Direct .map append ────────────────────────
  // cleanUrl already has query stripped, so this is safe
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

  // Strip query string BEFORE building candidates — Hellhound-Spider does
  // `url.split('?')[0]` for exactly this reason. Without this, Strategy A
  // produces `app.js?v=abc123.map` which is a malformed URL that always 404s.
  const cleanUrl = stripQuery(assetUrl);

  const probed = new Set<string>();

  for (const buildCandidate of MAP_CANDIDATES) {
    let candidate: string | null;
    try {
      candidate = buildCandidate(cleanUrl);
      if (!candidate) continue;

      // Skip if it produces the same URL as the original asset
      if (candidate === assetUrl || candidate === cleanUrl) continue;

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

    // ── HEAD probe first (no body download) ────────────────
    const { exists, headers } = await headUrl(candidate, ctx);

    if (exists) {
      // Reject SPA catch-all fallbacks: if the server returns text/html
      // for a .map URL, it's the SPA's index.html, not a real source map.
      const ct = headers["content-type"] ?? "";
      if (ct.includes("text/html")) {
        ctx.logger.debug(
          `Path inferrer: ${candidate} returned text/html (SPA fallback) — skipping`,
          { stage: "stage-2", asset_url: assetUrl }
        );
        continue;
      }

      ctx.logger.info(`Path inferrer: found map at ${candidate}`, {
        stage: "stage-2",
        asset_url: assetUrl,
      });
      return { found: true, url: candidate };
    }

    // ── GET fallback (mirrors Hellhound-Spider's approach) ──
    // Some servers respond with 405 (Method Not Allowed) or simply
    // ignore HEAD requests. Fall back to a GET probe and validate
    // the response body contains source-map JSON markers.
    // This matches Hellhound-Spider's `_check_sourcemap` which
    // always uses GET and checks for '"sources":' and '"mappings":'.
    try {
      const getRes = await fetchUrl(candidate, ctx);
      if (getRes.status >= 200 && getRes.status < 300) {
        const ct = getRes.headers["content-type"] ?? "";
        if (ct.includes("text/html")) {
          ctx.logger.debug(
            `Path inferrer (GET fallback): ${candidate} returned text/html — skipping`,
            { stage: "stage-2", asset_url: assetUrl }
          );
          continue;
        }

        // Validate body is parseable source-map JSON
        const body = getRes.body.trimStart();
        if (body.startsWith("<")) continue;
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (
            (Array.isArray(parsed.sources) || typeof parsed.mappings === "string") &&
            (parsed.version === 3 || Array.isArray(parsed.sections))
          ) {
            ctx.logger.info(
              `Path inferrer (GET fallback): found map at ${candidate}`,
              { stage: "stage-2", asset_url: assetUrl }
            );
            return { found: true, url: candidate };
          }
        } catch {
          // not JSON
        }
      }
    } catch {
      // GET also failed — move on to next candidate
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
