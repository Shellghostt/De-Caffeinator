// ============================================================
// BLOB UNPACKER — PLAYWRIGHT CRAWLER (Phase 4: SPA_DOM)
//
// Opens each crawled page in a real Chromium/Firefox/WebKit
// browser and intercepts every network request the browser
// makes while executing the page's JavaScript.
//
// This catches JS files that are:
//   - Dynamically injected via document.createElement("script")
//   - Loaded via import() / dynamic ESM imports
//   - Referenced only after SPA route transitions
//   - Loaded by plugin/widget bootstrap code (e.g., React players)
//
// Strategy:
//   1. Launch a single browser instance shared across all pages
//   2. For each page, intercept requests BEFORE navigation fires
//   3. Navigate with waitUntil = networkidle (lets all async JS run)
//   4. Collect JS URLs the browser fetched that the static pass missed
//   5. Download those URLs via the normal fetchUrl() path (rate-limited)
//   6. Return AssetRecord[] for the queue
//
// Mirrors Hellhound-Spider's SPA_DOM discovery source.
// ============================================================

import { PipelineContext } from "../../core/context";
import { AssetRecord } from "../../types/contracts";
import { fetchUrl } from "../../lib/http";
import { sha256 } from "../../lib/hasher";
import { classifyAsset, isJavaScript } from "./classifier";

// JS resource types that Playwright intercepts
const JS_RESOURCE_TYPES = new Set(["script", "fetch", "xhr", "other"]);

// Extensions that are definitely not JavaScript
const NON_JS_EXTENSIONS = /\.(css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|webp|mp4|mp3|pdf|zip|json|xml|txt|map)(\?|$)/i;

let loadOrderOffset = 10000; // Start high so Playwright assets sort after static ones

/**
 * Run a Playwright-based browser pass over the given page URLs.
 * Intercepts all JS network requests and returns AssetRecord[] for
 * URLs not already in knownUrls.
 *
 * @param pageUrls  Pages to open in the browser (from static crawl)
 * @param knownUrls Set of already-discovered asset URLs (normalized, lowercase)
 * @param ctx       Pipeline context
 */
export async function playwrightCrawl(
  pageUrls: string[],
  knownUrls: Set<string>,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const cfg = ctx.config.playwright;
  if (!cfg?.enabled) return [];

  loadOrderOffset = 10000;

  // Lazy-import playwright to avoid hard dependency when not enabled
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    ctx.logger.warn(
      "Playwright: package not installed. Run `npm install playwright` and `npx playwright install chromium`.",
      { stage: "stage-1" }
    );
    return [];
  }

  ctx.logger.info(
    `Playwright: launching ${cfg.browser} (headless=${cfg.headless}) for ${Math.min(pageUrls.length, cfg.max_pages)} page(s)`,
    { stage: "stage-1" }
  );

  const browserType = playwright[cfg.browser];
  let browser: import("playwright").Browser | null = null;

  /** Full normalized URL dedup (with query) */
  const discoveredUrls = new Set<string>();
  /** Path+host dedup — prevents timestamp-varying ?ver= from causing duplicate fetches.
   *  Key includes hostname so cdnA/app.js and cdnB/app.js are distinct. */
  const discoveredPaths = new Set<string>();

  // Pre-populate path dedup from known static URLs
  for (const url of knownUrls) {
    try {
      const u = new URL(url);
      discoveredPaths.add(`${u.hostname.toLowerCase()}|${u.pathname.toLowerCase()}`);
    } catch { /* skip */ }
  }

  const records: AssetRecord[] = [];

  // Target origin for same-site filtering of intercepted fetches
  let targetOrigin = "";
  let targetHost = "";
  try {
    const seed = ctx.config.target_urls[0];
    if (seed) {
      const u = new URL(seed.startsWith("http") ? seed : `https://${seed}`);
      targetOrigin = u.origin;
      targetHost = u.hostname.replace(/^www\./, "").toLowerCase();
    }
  } catch { /* leave empty — allow all (SSRF still guarded in fetchUrl) */ }

  try {
    // Prefer sandboxed Chromium; only disable sandbox in known container CI envs
    const inContainer = Boolean(process.env.CI || process.env.KUBERNETES_SERVICE_HOST);
    browser = await browserType.launch({
      headless: cfg.headless,
      args: [
        ...(inContainer ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const pagesToVisit = pageUrls.slice(0, cfg.max_pages);

    for (const pageUrl of pagesToVisit) {
      const pageRecords = await visitPage(
        pageUrl,
        browser,
        knownUrls,
        discoveredUrls,
        discoveredPaths,
        cfg,
        ctx,
        targetOrigin,
        targetHost
      );
      records.push(...pageRecords);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Playwright: browser error — ${msg}`, { stage: "stage-1" });
    // Non-fatal: fall through and return whatever we got
  } finally {
    try {
      await browser?.close();
    } catch { /* ignore close errors */ }
  }

  ctx.logger.info(
    `Playwright: discovered ${records.length} new JS asset(s) from ${Math.min(pageUrls.length, cfg.max_pages)} page(s)`,
    { stage: "stage-1" }
  );

  return records;
}

// ----------------------------------------------------------
// INTERNAL: visit one page and collect intercepted JS URLs
// ----------------------------------------------------------

async function visitPage(
  pageUrl: string,
  browser: import("playwright").Browser,
  knownUrls: Set<string>,
  discoveredUrls: Set<string>,
  discoveredPaths: Set<string>,
  cfg: NonNullable<PipelineContext["config"]["playwright"]>,
  ctx: PipelineContext,
  targetOrigin: string,
  targetHost: string
): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];
  const intercepted: string[] = [];
  const MAX_INTERCEPTS = 200;

  let page: import("playwright").Page | null = null;
  try {
    page = await browser.newPage();

    // Spoof user-agent to match what the static crawler uses
    await page.setExtraHTTPHeaders({
      "User-Agent": ctx.config.http.user_agent,
    });

    // ── Intercept every network request BEFORE navigation ──
    // We collect script-type requests and any fetch/XHR that
    // resolves to a .js URL. Abort is NOT used — we let all
    // requests complete so the page renders fully.
    page.on("request", (req) => {
      if (intercepted.length >= MAX_INTERCEPTS) return;

      const type = req.resourceType();
      const url = req.url();

      if (!JS_RESOURCE_TYPES.has(type)) return;
      if (NON_JS_EXTENSIONS.test(url)) return;
      if (!url.startsWith("http")) return;

      // Restrict re-fetches to target site (+ subdomains). Private IPs still
      // blocked in fetchUrl. Third-party CDNs on unrelated hosts are skipped
      // to limit SSRF / fetch storms (static crawl already covers linked CDNs).
      if (targetHost) {
        try {
          const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
          const allowed =
            host === targetHost ||
            host.endsWith("." + targetHost);
          if (!allowed) return;
        } catch {
          return;
        }
      }

      // For non-script resource types, only accept URLs that look like JS
      if (type !== "script" && !url.split("?")[0].endsWith(".js")) return;

      const normalized = normalizeUrl(url);
      if (knownUrls.has(normalized)) return;
      if (discoveredUrls.has(normalized)) return;

      let pathKey: string;
      try {
        const u = new URL(url);
        pathKey = `${u.hostname.toLowerCase()}|${u.pathname.toLowerCase()}`;
      } catch {
        pathKey = url;
      }
      if (discoveredPaths.has(pathKey)) return;
      discoveredPaths.add(pathKey);

      intercepted.push(url);
      discoveredUrls.add(normalized);
    });

    ctx.logger.debug(`Playwright: navigating to ${pageUrl}`, { stage: "stage-1" });

    await page.goto(pageUrl, {
      timeout: cfg.timeout_ms,
      waitUntil: cfg.wait_until,
    });

    // Extra wait: some lazy-loaders fire after networkidle settles
    // (e.g. IntersectionObserver-based imports). 1s is a reasonable buffer.
    await page.waitForTimeout(1000);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.debug(`Playwright: navigation failed for ${pageUrl}: ${msg}`, { stage: "stage-1" });
    // Fall through — collect whatever was intercepted before the failure
  } finally {
    try {
      await page?.close();
    } catch { /* ignore */ }
  }

  // ── Fetch each newly discovered JS URL ──────────────────
  for (const url of intercepted) {
    try {
      ctx.logger.debug(`Playwright: fetching intercepted JS ${url}`, { stage: "stage-1" });
      const res = await fetchUrl(url, ctx);

      if (res.status < 200 || res.status >= 300) continue;

      // Drop redirects that escape the target origin
      if (targetOrigin) {
        try {
          const finalHost = new URL(res.url).hostname.replace(/^www\./, "").toLowerCase();
          if (finalHost !== targetHost && !finalHost.endsWith("." + targetHost)) {
            continue;
          }
        } catch {
          continue;
        }
      }

      const ct = res.headers["content-type"] ?? "";
      if (!isJavaScript(res.body, ct)) continue;

      records.push({
        url: res.url,
        origin_page: pageUrl,
        content_hash: sha256(res.body),
        asset_type: classifyAsset(url, false),
        raw_content: res.body,
        fetch_headers: res.headers,
        fetched_at: new Date().toISOString(),
        load_order: loadOrderOffset++,
      });

      ctx.logger.info(`Playwright (SPA_DOM): new JS asset → ${url}`, { stage: "stage-1" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`Playwright: failed to fetch ${url}: ${msg}`, { stage: "stage-1" });
    }
  }

  return records;
}

// ----------------------------------------------------------
// HELPERS
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
