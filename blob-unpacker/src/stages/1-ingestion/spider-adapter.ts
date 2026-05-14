// ============================================================
// BLOB UNPACKER — SPIDER ADAPTER
// Accepts output from an external Spider (a full JS-executing
// web crawler). The Spider provides a richer asset list than
// the lightweight crawler — it captures dynamically loaded
// chunks, lazy routes, and SPA transitions.
//
// Expected Spider output format:
// [
//   { url: string, origin_page: string, script_type?: string },
//   ...
// ]
//
// The adapter fetches and validates each URL, producing
// AssetRecord objects ready for the queue.
// ============================================================

import * as fs from "fs";
import { AssetRecord } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { fetchUrl } from "../../lib/http";
import { sha256 } from "../../lib/hasher";
import { classifyAsset, isJavaScript } from "./classifier";

export interface SpiderEntry {
  url: string;
  origin_page: string;
  script_type?: string;
}

/**
 * Load Spider output from a JSON file path and produce AssetRecords.
 * The Spider has already done the crawling — we just fetch and validate.
 */
export async function ingestFromSpider(
  spiderOutputPath: string,
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  ctx.logger.info(`Spider adapter: loading ${spiderOutputPath}`, { stage: "stage-1" });

  let entries: SpiderEntry[];

  try {
    const raw = fs.readFileSync(spiderOutputPath, "utf-8");
    entries = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Spider adapter: failed to parse ${spiderOutputPath}: ${err}`);
  }

  if (!Array.isArray(entries)) {
    throw new Error("Spider adapter: expected a JSON array at top level");
  }

  ctx.logger.info(`Spider adapter: ${entries.length} URLs to fetch`, { stage: "stage-1" });

  const records: AssetRecord[] = [];

  for (const entry of entries) {
    if (!entry.url || typeof entry.url !== "string") {
      ctx.logger.warn("Spider adapter: skipping entry with no url", { stage: "stage-1" });
      continue;
    }

    try {
      const record = await fetchAndValidate(entry, ctx);
      if (record) records.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Spider adapter: failed ${entry.url}: ${msg}`, {
        stage: "stage-1",
        asset_url: entry.url,
      });
    }
  }

  ctx.logger.info(`Spider adapter: produced ${records.length} valid asset record(s)`, {
    stage: "stage-1",
  });

  return records;
}

/**
 * Accept Spider entries passed in-memory (no file I/O).
 * Useful when the Spider is co-located in the same process.
 */
export async function ingestFromSpiderEntries(
  entries: SpiderEntry[],
  ctx: PipelineContext
): Promise<AssetRecord[]> {
  const records: AssetRecord[] = [];

  for (const entry of entries) {
    try {
      const record = await fetchAndValidate(entry, ctx);
      if (record) records.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Spider adapter: failed ${entry.url}: ${msg}`, {
        stage: "stage-1",
        asset_url: entry.url,
      });
    }
  }

  return records;
}

// ----------------------------------------------------------
// INTERNAL
// ----------------------------------------------------------

async function fetchAndValidate(
  entry: SpiderEntry,
  ctx: PipelineContext
): Promise<AssetRecord | null> {
  ctx.logger.debug(`Spider adapter: fetching ${entry.url}`, { stage: "stage-1" });

  const res = await fetchUrl(entry.url, ctx);

  if (res.status < 200 || res.status >= 300) {
    ctx.logger.warn(`Spider adapter: HTTP ${res.status} for ${entry.url}`, {
      stage: "stage-1",
    });
    return null;
  }

  const contentType = res.headers["content-type"];
  if (!isJavaScript(res.body, contentType)) {
    ctx.logger.warn(`Spider adapter: skipping non-JS at ${entry.url}`, {
      stage: "stage-1",
    });
    return null;
  }

  const isInline = entry.script_type === "inline";

  return {
    url: res.url,
    origin_page: entry.origin_page,
    content_hash: sha256(res.body),
    asset_type: classifyAsset(entry.url, isInline),
    raw_content: res.body,
    fetch_headers: res.headers,
    fetched_at: new Date().toISOString(),
  };
}
