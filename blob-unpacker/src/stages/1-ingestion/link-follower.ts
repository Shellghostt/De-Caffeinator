// ============================================================
// BLOB UNPACKER — LINK FOLLOWER (Multi-page SPA Crawler)
// Traverses same-origin <a href> links up to a configurable
// depth, collecting all reachable pages so we can extract
// scripts from each one. This catches assets that only appear
// on specific routes (e.g., /dashboard loads dashboard.chunk.js).
// ============================================================

import { PipelineContext } from "../../core/context";
import { fetchUrl } from "../../lib/http";

// Matches <a href="..."> links
const ANCHOR_HREF_RE = /<a[^>]+href=["']([^"'#]+)["']/gi;

// File extensions to skip (not HTML pages)
const SKIP_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|map|json|xml|txt|mp[34]|webm|webp)$/i;

// Paths that are almost never worth crawling
const SKIP_PATHS = /\/(logout|signout|delete|unsubscribe|api\/|graphql|ws\/|socket)/i;

export interface FollowedPage {
  url: string;
  html: string;
}

/**
 * Starting from the entry HTML, follow same-origin links up to `maxDepth` levels.
 * Returns all discovered pages (including the entry page itself).
 *
 * Depth 0 = just the entry page (no following).
 * Depth 1 = entry page + all pages linked from it.
 * Depth 2 = above + all pages linked from depth-1 pages.
 */
export async function followLinks(
  entryUrl: string,
  entryHtml: string,
  ctx: PipelineContext
): Promise<FollowedPage[]> {
  const maxDepth = ctx.config.crawl?.max_depth ?? 0;

  if (maxDepth <= 0) {
    return []; // No link following — caller already has the entry page
  }

  const maxPages = ctx.config.crawl?.max_pages ?? 50;

  let origin: string;
  try {
    origin = new URL(entryUrl).origin;
  } catch {
    return [];
  }

  const visited = new Set<string>();
  visited.add(normalizePageUrl(entryUrl));

  const results: FollowedPage[] = [];

  // BFS queue: [url, html, depth]
  let frontier: Array<{ url: string; html: string; depth: number }> = [
    { url: entryUrl, html: entryHtml, depth: 0 },
  ];

  while (frontier.length > 0 && results.length < maxPages) {
    const nextFrontier: typeof frontier = [];

    for (const { url, html, depth } of frontier) {
      if (depth >= maxDepth) continue;

      const links = extractSameOriginLinks(html, url, origin);
      ctx.logger.debug(
        `Link follower: found ${links.length} same-origin links on ${url} (depth ${depth})`,
        { stage: "stage-1" }
      );

      for (const link of links) {
        if (results.length >= maxPages) break;

        const normalized = normalizePageUrl(link);
        if (visited.has(normalized)) continue;
        visited.add(normalized);

        try {
          ctx.logger.debug(`Link follower: fetching ${link}`, { stage: "stage-1" });
          const res = await fetchUrl(link, ctx);

          if (res.status < 200 || res.status >= 300) continue;

          // Only follow HTML pages
          const ct = res.headers["content-type"] ?? "";
          if (!ct.includes("text/html")) continue;

          const page: FollowedPage = { url: res.url, html: res.body };
          results.push(page);
          nextFrontier.push({ url: res.url, html: res.body, depth: depth + 1 });

          ctx.logger.info(
            `Link follower: discovered page ${res.url} (depth ${depth + 1})`,
            { stage: "stage-1" }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.debug(`Link follower: failed to fetch ${link}: ${msg}`, {
            stage: "stage-1",
          });
        }
      }
    }

    frontier = nextFrontier;
  }

  ctx.logger.info(
    `Link follower: discovered ${results.length} additional page(s) (max depth ${maxDepth})`,
    { stage: "stage-1" }
  );

  return results;
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function extractSameOriginLinks(html: string, pageUrl: string, origin: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  ANCHOR_HREF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANCHOR_HREF_RE.exec(html)) !== null) {
    const href = match[1].trim();

    // Skip anchors, javascript:, mailto:, tel:
    if (!href || href.startsWith("#") || href.startsWith("javascript:") ||
        href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    // Skip file downloads and media
    if (SKIP_EXTENSIONS.test(href)) continue;

    // Skip known non-page paths
    if (SKIP_PATHS.test(href)) continue;

    try {
      const resolved = new URL(href, pageUrl);

      // Same origin only
      if (resolved.origin !== origin) continue;

      // Strip fragments and query for dedup
      resolved.hash = "";
      const normalized = resolved.href;

      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    } catch {
      // Malformed URL — skip
    }
  }

  return links;
}

function normalizePageUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href.toLowerCase().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/\/$/, "");
  }
}
