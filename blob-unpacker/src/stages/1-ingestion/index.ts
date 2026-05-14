// ============================================================
// BLOB UNPACKER — STAGE 1: INGESTION (Entry Point)
// Routes to either the Spider adapter or Lightweight Crawler
// based on config.input_mode. Populates the queue.
// ============================================================

import { AssetQueue } from "../../core/queue";
import { PipelineContext } from "../../core/context";
import { crawlEntry } from "./crawler-adapter";
import { ingestFromSpider, SpiderEntry } from "./spider-adapter";

export interface IngestionOptions {
  /** For spider mode: path to spider JSON output file */
  spiderOutputPath?: string;
  /** For spider mode: in-memory entries (alternative to file) */
  spiderEntries?: SpiderEntry[];
}

export async function runIngestion(
  queue: AssetQueue,
  ctx: PipelineContext,
  opts: IngestionOptions = {}
): Promise<number> {
  ctx.logger.info(`Stage 1: Ingestion starting (mode: ${ctx.config.input_mode})`, {
    stage: "stage-1",
  });

  const records =
    ctx.config.input_mode === "spider"
      ? await runSpiderMode(ctx, opts)
      : await runCrawlMode(ctx);

  let accepted = 0;
  for (const record of records) {
    if (queue.enqueue(record)) accepted++;
  }

  ctx.logger.info(
    `Stage 1: complete — ${records.length} fetched, ${accepted} enqueued (${records.length - accepted} deduplicated)`,
    { stage: "stage-1" }
  );

  return accepted;
}

async function runSpiderMode(ctx: PipelineContext, opts: IngestionOptions) {
  if (opts.spiderEntries) {
    const { ingestFromSpiderEntries } = await import("./spider-adapter");
    return ingestFromSpiderEntries(opts.spiderEntries, ctx);
  }
  if (opts.spiderOutputPath) {
    return ingestFromSpider(opts.spiderOutputPath, ctx);
  }
  throw new Error("Spider mode requires spiderOutputPath or spiderEntries");
}

async function runCrawlMode(ctx: PipelineContext) {
  const records = [];
  for (const url of ctx.config.target_urls) {
    const fetched = await crawlEntry(url, ctx);
    records.push(...fetched);
  }
  return records;
}
