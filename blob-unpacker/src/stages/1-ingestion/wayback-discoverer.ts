// ============================================================
// BLOB UNPACKER — WAYBACK MACHINE DISCOVERER (Phase 5)
//
// Queries the Wayback Machine CDX (Capture Index) API to find
// historical JavaScript URLs for the target domain that may
// no longer appear in current HTML but are still accessible.
//
// Why this matters:
//   - Developers often ship source maps in early deploys then
//     remove them — the Wayback Machine preserves the old URL.
//   - Plugin/theme updates may rename or reorganize JS files.
//   - The CDX API returns canonical URLs grouped by content
//     (collapse=urlkey) so we don't get hundreds of duplicates.
//
// API used:
//   https://web.archive.org/cdx/search/cdx
//   Parameters:
//     url       = *.hostname.tld/*        (wildcard for all paths)
//     output    = json
//     fl        = original,timestamp      (fields: URL, snapshot date)
//     filter    = mimetype:text/javascript OR statuscode:200
//     collapse  = urlkey                  (deduplicate by URL)
//     limit     = cfg.max_results
//
// Mirrors Hellhound-Spider's Wayback discovery source.
// ============================================================

import { URL } from "url";
import { PipelineContext } from "../../core/context";
import { AssetRecord } from "../../types/contracts";
import { fetchUrl } from "../../lib/http";
import { sha256 } from "../../lib/hasher";
import { classifyAsset, isJavaScript } from "./classifier";

const CDX_API_BASE = "https://web.archive.org/cdx/search/cdx";

let loadOrderOffset = 20000; // Start high so Wayback assets sort after Playwright ones

/**
 * Query the Wayback Machine for historical JS URLs for the target domain,
 * then fetch any that aren't already known to the pipeline.
 *
 * @param targetUrl  The target entry URL (used to derive the hostname)
 * @param knownUrls  Set of already-discovered asset URLs (normalized)
 * @param ctx        Pipeline context
 */
export async function waybackDiscover(
  targetUrl: string,
  knownUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const cfg = ctx.config.wayback;
  if (!cfg?.enabled) return [];

  let hostname: string;
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    ctx.logger.warn(`Wayback: invalid target URL ${targetUrl}`, { stage: "stage-1" });
    return [];
  }

  ctx.logger.info(
    `Wayback: querying CDX API for ${hostname} (max ${cfg.max_results} results)`,
    { stage: "stage-1" }
  );

  // Build CDX query URL
  const params = new URLSearchParams({
    url: `*.${hostname}/*`,
    output: "json",
    fl: "original,timestamp",
    filter: "mimetype:text/javascript",
    collapse: "urlkey",
    limit: String(cfg.max_results),
  });

  const cdxUrl = `${CDX_API_BASE}?${params.toString()}`;

  let cdxRows: string[][];
  try {
    cdxRows = await fetchCdxJson(cdxUrl, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Wayback: CDX query failed — ${msg}`, { stage: "stage-1" });
    return [];
  }

  if (cdxRows.length === 0) {
    ctx.logger.info("Wayback: no JS URLs found in CDX index for this domain", { stage: "stage-1" });
    return [];
  }

  ctx.logger.info(`Wayback: CDX returned ${cdxRows.length} historical JS URL(s)`, { stage: "stage-1" });

  const records: AssetRecord[] = [];
  const now = Date.now();
  const maxAgeMs = cfg.max_age_days > 0 ? cfg.max_age_days * 24 * 60 * 60 * 1000 : Infinity;

  for (const row of cdxRows) {
    // CDX row: [original_url, timestamp]
    // First row is the header ["original", "timestamp"] — skip it
    if (row[0] === "original") continue;

    const originalUrl = row[0];
    const timestamp = row[1]; // format: YYYYMMDDHHmmss

    // Age filter
    if (maxAgeMs !== Infinity && timestamp) {
      const snapDate = parseTimestamp(timestamp);
      if (snapDate && now - snapDate.getTime() > maxAgeMs) {
        continue;
      }
    }

    // Skip non-JS file extensions
    const cleanPath = originalUrl.split("?")[0].toLowerCase();
    if (!cleanPath.endsWith(".js") && !cleanPath.endsWith(".mjs")) continue;

    // Skip if already known
    const normalized = normalizeUrl(originalUrl);
    if (knownUrls.has(normalized)) continue;

    // Skip obvious third-party CDN URLs (we want same-host assets)
    try {
      const urlObj = new URL(originalUrl);
      if (urlObj.hostname !== hostname && !urlObj.hostname.endsWith(`.${hostname}`)) {
        continue;
      }
    } catch {
      continue;
    }

    // Fetch the live URL (not the Wayback archive copy) first —
    // if it's still alive, we get the current version which may have
    // a source map. If it 404s, try the archived copy.
    let record = await tryFetchLive(originalUrl, hostname, knownUrls, ctx);

    if (!record) {
      // Fall back to the Wayback archived snapshot
      record = await tryFetchArchived(originalUrl, timestamp, hostname, knownUrls, ctx);
    }

    if (record) {
      records.push(record);
      knownUrls.add(normalizeUrl(record.url));
      ctx.logger.info(`Wayback: discovered JS asset → ${record.url}`, { stage: "stage-1" });
    }
  }

  ctx.logger.info(
    `Wayback: fetched ${records.length} new JS asset(s) from historical archive`,
    { stage: "stage-1" }
  );

  return records;
}

// ----------------------------------------------------------
// FETCH HELPERS
// ----------------------------------------------------------

async function tryFetchLive(
  url: string,
  hostname: string,
  knownUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord | null> {
  try {
    const res = await fetchUrl(url, ctx);
    if (res.status < 200 || res.status >= 300) return null;
    const ct = res.headers["content-type"] ?? "";
    if (!isJavaScript(res.body, ct)) return null;

    return {
      url: res.url,
      origin_page: `wayback://${hostname}`,
      content_hash: sha256(res.body),
      asset_type: classifyAsset(url, false),
      raw_content: res.body,
      fetch_headers: res.headers,
      fetched_at: new Date().toISOString(),
      load_order: loadOrderOffset++,
    };
  } catch {
    return null;
  }
}

async function tryFetchArchived(
  originalUrl: string,
  timestamp: string,
  hostname: string,
  knownUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord | null> {
  // Wayback Machine URL format: https://web.archive.org/web/{timestamp}id_/{original_url}
  // The `id_` modifier returns the raw original resource without Wayback toolbar injection
  const archiveUrl = `https://web.archive.org/web/${timestamp}id_/${originalUrl}`;

  try {
    const res = await fetchUrl(archiveUrl, ctx);
    if (res.status < 200 || res.status >= 300) return null;
    const ct = res.headers["content-type"] ?? "";
    if (!isJavaScript(res.body, ct)) return null;

    // Remove any Wayback Machine injection headers/comments
    const cleanBody = stripWaybackInjection(res.body);

    return {
      url: originalUrl, // Use original URL, not the archive URL
      origin_page: `wayback://${hostname}`,
      content_hash: sha256(cleanBody),
      asset_type: classifyAsset(originalUrl, false),
      raw_content: cleanBody,
      fetch_headers: res.headers,
      fetched_at: new Date().toISOString(),
      load_order: loadOrderOffset++,
    };
  } catch {
    return null;
  }
}

/**
 * Remove Wayback Machine header/footer injections from archived JS.
 * Wayback sometimes prepends a comment block or appends analytics.
 */
function stripWaybackInjection(code: string): string {
  // Remove the Wayback injection block at the top
  // Format: /* FILE ARCHIVED ON ... BY THE WAYBACK MACHINE ... */
  const stripped = code.replace(
    /^\/\*\s*FILE ARCHIVED ON[\s\S]*?WAYBACK MACHINE[\s\S]*?\*\/\s*/i,
    ""
  );
  return stripped;
}

// ----------------------------------------------------------
// CDX API FETCH
// ----------------------------------------------------------

/**
 * Fetch the CDX API and parse the JSON response.
 * Returns an array of rows (each row is an array of field values).
 * Uses the pipeline's own fetchUrl() so rate-limiting and User-Agent are shared.
 */
async function fetchCdxJson(url: string, ctx: PipelineContext): Promise<string[][]> {
  const res = await fetchUrl(url, ctx);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`CDX API returned HTTP ${res.status}`);
  }
  try {
    const parsed = JSON.parse(res.body) as string[][];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ----------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}

function parseTimestamp(ts: string): Date | null {
  // CDX timestamp format: YYYYMMDDHHmmss (14 chars)
  if (ts.length < 8) return null;
  try {
    const y = ts.slice(0, 4);
    const mo = ts.slice(4, 6);
    const d = ts.slice(6, 8);
    const h = ts.slice(8, 10) || "00";
    const mi = ts.slice(10, 12) || "00";
    const s = ts.slice(12, 14) || "00";
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  } catch {
    return null;
  }
}
