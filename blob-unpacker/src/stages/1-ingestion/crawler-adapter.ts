// ============================================================
// BLOB UNPACKER — ENHANCED CRAWLER ADAPTER
// Fetches HTML entry pages and extracts all JS assets using:
//   1. Static <script src=""> extraction from HTML
//   2. Inline <script> blocks
//   3. Multi-page link following (same-origin BFS crawl)
//   4. Dynamic chunk discovery (import(), webpack, React.lazy)
//
// This catches assets that only appear on sub-pages or are
// referenced dynamically inside JavaScript bundles.
// ============================================================

import { AssetRecord } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { fetchUrl } from "../../lib/http";
import { sha256 } from "../../lib/hasher";
import { classifyAsset, isJavaScript } from "./classifier";
import { followLinks, FollowedPage } from "./link-follower";
import {
  discoverChunks,
  extractPublicPath,
  resolveChunkRef,
} from "./chunk-discoverer";

// Matches <script src="..."> and <script type="module" src="...">
const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+\.js[^"']*)["']/gi;

// Matches inline <script>...</script> blocks (no src)
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi;

/** Global load order counter for this crawl session */
let loadOrderCounter = 0;

export async function crawlEntry(
  entryUrl: string,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  // Reset load order per entry URL crawl
  loadOrderCounter = 0;

  ctx.logger.info(`Crawler: fetching entry page ${entryUrl}`, { stage: "stage-1" });

  const html = await fetchUrl(entryUrl, ctx);

  if (html.status < 200 || html.status >= 300) {
    throw new Error(`Entry page returned HTTP ${html.status}: ${entryUrl}`);
  }

  const allRecords: AssetRecord[] = [];
  const seenUrls = new Set<string>();

  // ── Phase 1: Extract scripts from the entry page ──────
  const entryRecords = await extractScriptsFromPage(html.body, entryUrl, seenUrls, ctx);
  allRecords.push(...entryRecords);

  // ── Phase 1b: Next.js build manifest discovery ────────
  // Next.js puts all page→chunk mappings in /_next/static/XYZ/_buildManifest.js
  // This is the only reliable way to find all page-specific chunks in a Next.js app.
  const nextChunks = await discoverNextJsChunks(entryUrl, html.body, seenUrls, ctx);
  allRecords.push(...nextChunks);
  if (nextChunks.length > 0) {
    ctx.logger.info(
      `Crawler: discovered ${nextChunks.length} Next.js page chunk(s) from buildManifest`,
      { stage: "stage-1" }
    );
  }

  // ── Phase 2: Follow same-origin links (multi-page crawl) ─
  const followedPages = await followLinks(entryUrl, html.body, ctx);

  for (const page of followedPages) {
    const pageRecords = await extractScriptsFromPage(page.html, page.url, seenUrls, ctx);
    allRecords.push(...pageRecords);
  }

  ctx.logger.info(
    `Crawler: ${allRecords.length} assets from HTML (entry + ${followedPages.length} followed page(s))`,
    { stage: "stage-1" }
  );

  // ── Phase 3: Discover chunks referenced inside JS bundles ─
  if (ctx.config.crawl?.discover_chunks !== false) {
    const chunkRecords = await discoverChunksFromAssets(allRecords, seenUrls, ctx);
    allRecords.push(...chunkRecords);

    if (chunkRecords.length > 0) {
      ctx.logger.info(
        `Crawler: discovered ${chunkRecords.length} additional chunk(s) from JS analysis`,
        { stage: "stage-1" }
      );
    }
  }

  ctx.logger.info(`Crawler: produced ${allRecords.length} total asset record(s) from ${entryUrl}`, {
    stage: "stage-1",
  });

  return allRecords;
}

// ----------------------------------------------------------
// PHASE 1 & 2: Extract scripts from a single HTML page
// ----------------------------------------------------------

async function extractScriptsFromPage(
  html: string,
  pageUrl: string,
  seenUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  const base = resolveBase(pageUrl, html);

  // ── External <script src="..."> ─────────────────────────
  const externalUrls = extractScriptSrcs(html, base);
  ctx.logger.info(`Crawler: found ${externalUrls.length} external script(s) on ${pageUrl}`, {
    stage: "stage-1",
  });

  for (const url of externalUrls) {
    if (seenUrls.has(normalizeForDedup(url))) continue;
    seenUrls.add(normalizeForDedup(url));

    try {
      const record = await fetchAsset(url, pageUrl, false, ctx);
      if (record) records.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Crawler: failed to fetch ${url}: ${msg}`, { stage: "stage-1" });
    }
  }

  // ── Inline <script> blocks ──────────────────────────────
  const inlineScripts = extractInlineScripts(html);
  ctx.logger.info(`Crawler: found ${inlineScripts.length} inline script(s) on ${pageUrl}`, {
    stage: "stage-1",
  });

  for (const content of inlineScripts) {
    if (!isJavaScript(content)) continue;

    const hash = sha256(content);
    const inlineUrl = `inline://${pageUrl}#${hash.slice(0, 8)}`;
    if (seenUrls.has(normalizeForDedup(inlineUrl))) continue;
    seenUrls.add(normalizeForDedup(inlineUrl));

    records.push(buildInlineRecord(content, pageUrl));
  }

  return records;
}

// ----------------------------------------------------------
// PHASE 3: Discover chunks referenced inside JS source
// ----------------------------------------------------------

async function discoverChunksFromAssets(
  existingRecords: AssetRecord[],
  seenUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const discovered: AssetRecord[] = [];

  for (const record of existingRecords) {
    // Only scan external JS (inline scripts rarely contain chunk refs)
    if (record.asset_type === "inline") continue;

    const chunks = discoverChunks(record.raw_content);
    if (chunks.length === 0) continue;

    const publicPath = extractPublicPath(record.raw_content);

    ctx.logger.debug(
      `Chunk discovery: found ${chunks.length} reference(s) in ${record.url}` +
        (publicPath ? ` (publicPath: ${publicPath})` : ""),
      { stage: "stage-1", asset_url: record.url }
    );

    for (const chunk of chunks) {
      const candidates = resolveChunkRef(chunk, record.url, publicPath);

      for (const candidateUrl of candidates) {
        if (seenUrls.has(normalizeForDedup(candidateUrl))) continue;
        seenUrls.add(normalizeForDedup(candidateUrl));

        try {
          const chunkRecord = await fetchAsset(candidateUrl, record.url, false, ctx);
          if (chunkRecord) {
            ctx.logger.info(
              `Chunk discovery: fetched ${candidateUrl} (via ${chunk.source})`,
              { stage: "stage-1", asset_url: record.url }
            );
            discovered.push(chunkRecord);
            break; // First successful candidate wins — don't fetch duplicates
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.debug(
            `Chunk discovery: failed ${candidateUrl}: ${msg}`,
            { stage: "stage-1" }
          );
        }
      }
    }
  }

  // Recursive: scan the newly discovered chunks for more references (one level only)
  if (discovered.length > 0) {
    const secondPass: AssetRecord[] = [];
    for (const rec of discovered) {
      const innerChunks = discoverChunks(rec.raw_content);
      if (innerChunks.length === 0) continue;

      const publicPath = extractPublicPath(rec.raw_content);

      for (const chunk of innerChunks) {
        const candidates = resolveChunkRef(chunk, rec.url, publicPath);

        for (const candidateUrl of candidates) {
          if (seenUrls.has(normalizeForDedup(candidateUrl))) continue;
          seenUrls.add(normalizeForDedup(candidateUrl));

          try {
            const chunkRecord = await fetchAsset(candidateUrl, rec.url, false, ctx);
            if (chunkRecord) {
              secondPass.push(chunkRecord);
              break;
            }
          } catch {
            // Silently skip
          }
        }
      }
    }

    if (secondPass.length > 0) {
      ctx.logger.info(
        `Chunk discovery (2nd pass): found ${secondPass.length} more chunk(s)`,
        { stage: "stage-1" }
      );
      discovered.push(...secondPass);
    }
  }

  return discovered;
}

// ----------------------------------------------------------
// NEXT.JS BUILD MANIFEST DISCOVERY
// ----------------------------------------------------------
// Next.js emits /_next/static/<buildId>/_buildManifest.js which
// maps every page route → its JS chunks. Fetching this gives us
// every page-specific chunk that would never appear in static HTML.

// Matches the build ID from /_next/static/<id>/ paths in HTML
const NEXT_BUILD_ID_RE = /\/_next\/static\/([a-zA-Z0-9_-]{8,})\//;

// Matches all JS file paths inside a buildManifest JSON blob
const NEXT_MANIFEST_CHUNK_RE = /"([^"]+\.js)"/g;

// Also try to grab from __NEXT_DATA__ (the inline SSR data blob)
const NEXT_DATA_BUILD_ID_RE = /"buildId"\s*:\s*"([^"]+)"/;

async function discoverNextJsChunks(
  entryUrl: string,
  html: string,
  seenUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const discovered: AssetRecord[] = [];

  let origin: string;
  try {
    origin = new URL(entryUrl).origin;
  } catch {
    return [];
  }

  // Try to extract the build ID from the HTML
  let buildId: string | null = null;

  const idFromScript = NEXT_BUILD_ID_RE.exec(html);
  if (idFromScript) buildId = idFromScript[1];

  if (!buildId) {
    const idFromData = NEXT_DATA_BUILD_ID_RE.exec(html);
    if (idFromData) buildId = idFromData[1];
  }

  if (!buildId) {
    ctx.logger.debug("Crawler: no Next.js buildId found — skipping buildManifest discovery", {
      stage: "stage-1",
    });
    return [];
  }

  ctx.logger.info(`Crawler: detected Next.js buildId=${buildId}`, { stage: "stage-1" });

  // Probe both manifest files
  const manifestUrls = [
    `${origin}/_next/static/${buildId}/_buildManifest.js`,
    `${origin}/_next/static/${buildId}/_ssgManifest.js`,
  ];

  for (const manifestUrl of manifestUrls) {
    try {
      const res = await fetchUrl(manifestUrl, ctx);
      if (res.status < 200 || res.status >= 300) continue;

      ctx.logger.info(`Crawler: fetched Next.js manifest ${manifestUrl}`, { stage: "stage-1" });

      // Extract all chunk paths from the manifest
      NEXT_MANIFEST_CHUNK_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = NEXT_MANIFEST_CHUNK_RE.exec(res.body)) !== null) {
        const rawPath = match[1];

        // Build the full URL — paths start with _next/ (already relative to origin)
        let chunkUrl: string;
        try {
          chunkUrl = rawPath.startsWith("http")
            ? rawPath
            : new URL(rawPath.startsWith("/") ? rawPath : `/_next/static/${rawPath}`, origin).href;
        } catch {
          continue;
        }

        const normalized = chunkUrl.toLowerCase().replace(/\/$/, "");
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);

        try {
          const chunkRecord = await fetchAsset(chunkUrl, manifestUrl, false, ctx);
          if (chunkRecord) discovered.push(chunkRecord);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.debug(`Crawler: failed to fetch Next.js chunk ${chunkUrl}: ${msg}`, {
            stage: "stage-1",
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`Crawler: manifest probe failed ${manifestUrl}: ${msg}`, { stage: "stage-1" });
    }
  }

  return discovered;
}


// ----------------------------------------------------------

async function fetchAsset(
  url: string,
  originPage: string,
  isInline: boolean,
  ctx: PipelineContext
): Promise<AssetRecord | null> {
  ctx.logger.debug(`Crawler: fetching asset ${url}`, { stage: "stage-1" });

  const res = await fetchUrl(url, ctx);

  if (res.status < 200 || res.status >= 300) {
    ctx.logger.warn(`Crawler: asset returned HTTP ${res.status}: ${url}`, { stage: "stage-1" });
    return null;
  }

  const contentType = res.headers["content-type"];
  if (!isJavaScript(res.body, contentType)) {
    ctx.logger.warn(`Crawler: skipping non-JS response at ${url}`, { stage: "stage-1" });
    return null;
  }

  return {
    url: res.url,
    origin_page: originPage,
    content_hash: sha256(res.body),
    asset_type: classifyAsset(url, isInline),
    raw_content: res.body,
    fetch_headers: res.headers,
    fetched_at: new Date().toISOString(),
    load_order: loadOrderCounter++,
  };
}

function buildInlineRecord(content: string, originPage: string): AssetRecord {
  return {
    url: `inline://${originPage}#${sha256(content).slice(0, 8)}`,
    origin_page: originPage,
    content_hash: sha256(content),
    asset_type: "inline",
    raw_content: content,
    fetch_headers: {},
    fetched_at: new Date().toISOString(),
    load_order: loadOrderCounter++,
  };
}

// ----------------------------------------------------------
// HTML PARSING HELPERS
// ----------------------------------------------------------

function extractScriptSrcs(html: string, base: string): string[] {
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  SCRIPT_SRC_RE.lastIndex = 0;

  while ((match = SCRIPT_SRC_RE.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], base).href;
      urls.push(resolved);
    } catch {
      // Unparseable URL — skip
    }
  }

  return [...new Set(urls)]; // deduplicate
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  let match: RegExpExecArray | null;
  INLINE_SCRIPT_RE.lastIndex = 0;

  while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
    const content = match[1].trim();
    if (content.length > 50) scripts.push(content); // skip trivial snippets
  }

  return scripts;
}

/**
 * Resolve the effective base URL from the page's <base href=""> tag,
 * falling back to the page URL itself.
 */
function resolveBase(pageUrl: string, html: string): string {
  const baseMatch = /<base[^>]+href=["']([^"']+)["']/i.exec(html);
  if (baseMatch) {
    try {
      return new URL(baseMatch[1], pageUrl).href;
    } catch { /* fall through */ }
  }
  return pageUrl;
}

function normalizeForDedup(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}
