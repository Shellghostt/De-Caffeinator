// ============================================================
// BLOB UNPACKER — ENTRY POINT (Commander CLI)
//
// Single-command execution. No interactive prompts.
// Runs immediately when invoked with a target URL.
//
// Usage:
//   npx ts-node src/index.ts <url> [options]
//
// Examples:
//   npx ts-node src/index.ts https://example.com
//   npx ts-node src/index.ts https://example.com -o ./results
//   npx ts-node src/index.ts https://example.com -d 3 -p 100
//   npx ts-node src/index.ts https://example.com -c 10 --stealth
//   npx ts-node src/index.ts https://example.com --no-chunks --timeout 30000
// ============================================================

import * as readline from "readline/promises";
import { Command } from "commander";
import { PipelineContext, PipelineConfig } from "./core/context";
import { AssetQueue } from "./core/queue";
import { PipelineOrchestrator, PipelineStages } from "./core/pipeline";
import { runIngestion, IngestionOptions } from "./stages/1-ingestion";
import { detectMap } from "./stages/2-map-detection";
import { reconstruct } from "./stages/3-reconstruction";
import { deobfuscate } from "./stages/4-deobfuscation";
import { extract } from "./stages/5-extraction";
import { EventEmitter } from "events";

// ----------------------------------------------------------
// PIPELINE RUNNER (exported for programmatic use)
// ----------------------------------------------------------

/**
 * Run the blob-unpacker pipeline programmatically
 * @param userConfig Partial pipeline configuration
 * @param ingestionOpts Options for the ingestion stage
 * @param emitter Optional EventEmitter for real-time event streaming (web API integration)
 */
export async function run(
  userConfig: Partial<PipelineConfig> = {},
  ingestionOpts: IngestionOptions = {},
  emitter?: EventEmitter
): Promise<void> {
  const ctx = new PipelineContext(userConfig, emitter);
  const queue = new AssetQueue(ctx);

  ctx.logger.info("Blob Unpacker initialized", {
    stage: "bootstrap",
    target_count: ctx.config.target_urls.length,
    output_dir: ctx.config.output.dir,
  });

  const accepted = await runIngestion(queue, ctx, ingestionOpts);
  ctx.logger.info(`Queue loaded. ${accepted} asset(s) ready.`);

  const stages: PipelineStages = { detectMap, reconstruct, deobfuscate, extract };

  const orchestrator = new PipelineOrchestrator(ctx, queue, stages);
  await orchestrator.run();

  ctx.logger.info("Pipeline complete.");

  // Emit completion event for web API integration
  ctx.getEmitter().emit("complete", {
    timestamp: new Date().toISOString(),
    message: "Pipeline execution completed",
  });

  ctx.teardown();
}

// ----------------------------------------------------------
// BANNER
// ----------------------------------------------------------

function printBanner(): void {
  console.log(`
\x1b[96m\x1b[1m╔══════════════════════════════════════════════════════════════╗
║                      BLOB UNPACKER                         ║
║    JavaScript Reverse Engineering & Asset Analysis Tool     ║
╚══════════════════════════════════════════════════════════════╝\x1b[0m
  `);
}

function parsePositiveInt(raw: string, fallback: number, min = 1, max = 1_000_000): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseNonNegInt(raw: string, fallback: number, max = 1_000_000): number {
  return parsePositiveInt(raw, fallback, 0, max);
}

function parsePositiveFloat(raw: string, fallback: number, min = 0, max = 8): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeTargetUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid target URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs are supported (got ${parsed.protocol})`);
  }
  return parsed.href;
}

// ----------------------------------------------------------
// CLI DEFINITION (Commander)
// ----------------------------------------------------------

const program = new Command();

program
  .name("blob-unpacker")
  .description("JavaScript reverse engineering & asset analysis pipeline")
  .version("1.0.0")
  .argument("<url>", "Target URL to analyze (e.g. https://example.com)")

  // ── Output Options ──────────────────────────────────────
  .option("-o, --output <dir>", "Output directory", "./output")
  .option("-f, --format <fmt>", "Data format: json or jsonl", "json")
  .option("--no-files", "Don't write source/deobfuscated files to disk")

  // ── Crawl Options ───────────────────────────────────────
  .option("-d, --depth <n>", "Max crawl depth for link following", "3")
  .option("-p, --pages <n>", "Max pages to crawl", "100")
  .option("--no-chunks", "Disable dynamic chunk discovery")

  // ── HTTP Options ────────────────────────────────────────
  .option("-t, --timeout <ms>", "HTTP request timeout in ms", "20000")
  .option("-c, --concurrency <n>", "Max concurrent requests", "5")
  .option("--delay <ms>", "Delay between requests in ms", "300")
  .option("--user-agent <str>", "Custom User-Agent string", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

  // ── Browser Options (Playwright SPA_DOM) ────────────────
  .option("--playwright", "Enable Playwright headless browser scan (Phase 4 — SPA_DOM)")
  .option("--pw-browser <browser>", "Playwright browser engine: chromium | firefox | webkit", "chromium")
  .option("--pw-timeout <ms>", "Playwright page load timeout in ms", "30000")
  .option("--pw-pages <n>", "Max pages to visit with Playwright", "20")
  .option("--pw-visible", "Show browser window during Playwright scan (non-headless)")

  // ── Wayback Machine Options ──────────────────────────────
  .option("--wayback", "Enable Wayback Machine CDX historical JS discovery (Phase 5)")
  .option("--wb-results <n>", "Max Wayback CDX results to fetch", "200")
  .option("--wb-max-age <days>", "Only include snapshots newer than N days (0 = any age)", "0")

  // ── Analysis Options ────────────────────────────────────
  .option("--deobf-depth <n>", "Max de-obfuscation passes", "5")
  .option("--entropy <n>", "Min entropy for secret detection", "4.0")

  // ── Preset Profiles ─────────────────────────────────────
  .option("--quick", "Quick scan: entry page only, no chunk discovery")
  .option("--stealth", "Stealth mode: low concurrency, high delays")
  .option("--deep", "Deep recon: max depth, max pages, low entropy")

  // ── Action ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .action(async (rawUrl: string, opts: Record<string, any>) => {
    printBanner();

    let url: string;
    try {
      url = normalizeTargetUrl(rawUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n\x1b[91m\x1b[1m❌ ${msg}\x1b[0m\n`);
      process.exit(1);
      return;
    }

    // ── Apply preset profiles ─────────────────────────────
    if (opts.quick) {
      opts.depth = "0";
      opts.pages = "1";
      opts.concurrency = "3";
      opts.timeout = "10000";
      opts.delay = "200";
      opts.deobfDepth = "3";
      opts.entropy = "4.5";
      opts.chunks = false;
    }

    if (opts.stealth) {
      opts.depth = "2";
      opts.pages = "50";
      opts.concurrency = "1";
      opts.timeout = "30000";
      opts.delay = "2000";
    }

    if (opts.deep) {
      opts.depth = "5";
      opts.pages = "200";
      opts.concurrency = "3";
      opts.timeout = "30000";
      opts.delay = "500";
      opts.entropy = "3.5";
    }

    // ── Build config ──────────────────────────────────────
    const config: Partial<PipelineConfig> = {
      input_mode: "crawl",
      target_urls: [url],
      output: {
        dir: opts.output,
        write_source_files: opts.files !== false,
        format: (opts.format === "jsonl" ? "jsonl" : "json") as "json" | "jsonl",
      },
      http: {
        timeout_ms: parsePositiveInt(opts.timeout, 15000, 1000, 300000),
        max_concurrent: parsePositiveInt(opts.concurrency, 5, 1, 64),
        delay_between_ms: parseNonNegInt(opts.delay, 300, 60000),
        user_agent: opts.userAgent,
        max_response_bytes: 10 * 1024 * 1024,
      },
      crawl: {
        max_depth: parseNonNegInt(opts.depth, 2, 20),
        max_pages: parsePositiveInt(opts.pages, 50, 1, 10000),
        discover_chunks: opts.chunks !== false,
      },
      playwright: {
        enabled: Boolean(opts.playwright),
        browser: (opts.pwBrowser ?? "chromium") as "chromium" | "firefox" | "webkit",
        timeout_ms: parsePositiveInt(opts.pwTimeout ?? "30000", 30000, 1000, 300000),
        wait_until: "networkidle",
        headless: !opts.pwVisible,
        max_pages: parsePositiveInt(opts.pwPages ?? "20", 20, 1, 500),
      },
      wayback: {
        enabled: Boolean(opts.wayback),
        max_results: parsePositiveInt(opts.wbResults ?? "200", 200, 1, 5000),
        max_age_days: parseNonNegInt(opts.wbMaxAge ?? "0", 0, 36500),
      },
      deobfuscation: {
        max_depth: parsePositiveInt(opts.deobfDepth, 5, 1, 20),
        eval_sandbox: opts.evalSandbox !== false,
        string_array_threshold: 10,
      },
      extraction: {
        endpoint_patterns: [],
        secret_patterns: [],
        min_secret_entropy: parsePositiveFloat(opts.entropy, 4.5, 0, 8),
      },
    };

    // ── Print launch summary ──────────────────────────────
    console.log(`  🔍 Target:       ${url}`);
    console.log(`  📂 Output:       ${config.output!.dir}`);
    console.log(`  🕸️  Depth:        ${config.crawl!.max_depth}`);
    console.log(`  📄 Pages:        ${config.crawl!.max_pages}`);
    console.log(`  ⚡ Concurrency:  ${config.http!.max_concurrent}`);
    console.log(`  ⏱️  Timeout:      ${config.http!.timeout_ms}ms`);
    console.log(`  🔄 Deobf passes: ${config.deobfuscation!.max_depth}`);
    console.log(`  🔐 Min entropy:  ${config.extraction!.min_secret_entropy}`);
    console.log(`  📦 Chunks:       ${config.crawl!.discover_chunks ? "enabled" : "disabled"}`);
    console.log(`  🎭 Playwright:   ${config.playwright!.enabled ? `enabled (${config.playwright!.browser})` : "disabled"}`);
    console.log(`  📼 Wayback:      ${config.wayback!.enabled ? `enabled (max ${config.wayback!.max_results} results)` : "disabled"}`);
    console.log(`  💾 Write files:  ${config.output!.write_source_files ? "yes" : "no"}`);
    console.log();

    // ── Run the pipeline immediately ──────────────────────
    const startTime = Date.now();

    try {
      await run(config);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`\n\x1b[92m\x1b[1m✅ Pipeline completed successfully in ${elapsed}s\x1b[0m\n`);
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n\x1b[91m\x1b[1m❌ Pipeline failed after ${elapsed}s: ${msg}\x1b[0m\n`);
      process.exit(1);
    }
  });

// ----------------------------------------------------------
// MAIN
// ----------------------------------------------------------

async function runInteractiveMode() {
  printBanner();
  console.log("Welcome to Blob Unpacker Interactive Mode!");
  console.log("You can also run this tool from the command line for more options.");
  console.log("Example: blob-unpacker.exe https://example.com --deep\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let url: string;
  try {
    url = normalizeTargetUrl(await rl.question("Enter the Target URL (e.g., https://example.com): "));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${msg}`);
    await rl.question("\nPress Enter to exit...");
    rl.close();
    process.exit(1);
    return;
  }

  let outDir = await rl.question("Enter Output Directory (default: ./output): ");
  if (!outDir || outDir.trim() === "") {
    outDir = "./output";
  }

  console.log(`\nLaunching pipeline for ${url} -> ${outDir} ...\n`);

  const config: Partial<PipelineConfig> = {
    input_mode: "crawl",
    target_urls: [url],
    output: {
      dir: outDir,
      write_source_files: true,
      format: "json",
    },
    http: {
      timeout_ms: 15000,
      max_concurrent: 5,
      delay_between_ms: 300,
      user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      max_response_bytes: 10 * 1024 * 1024,
    },
    crawl: {
      max_depth: 2,
      max_pages: 50,
      discover_chunks: true,
    },
    deobfuscation: {
      max_depth: 5,
      eval_sandbox: true,
      string_array_threshold: 10,
    },
    extraction: {
      endpoint_patterns: [],
      secret_patterns: [],
      min_secret_entropy: 4.5,
    },
  };

  const startTime = Date.now();

  try {
    await run(config);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n\x1b[92m\x1b[1m✅ Pipeline completed successfully in ${elapsed}s\x1b[0m\n`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n\x1b[91m\x1b[1m❌ Pipeline failed after ${elapsed}s: ${msg}\x1b[0m\n`);
    await rl.question("\nPress Enter to exit...");
    rl.close();
    process.exit(1);
  }

  await rl.question("\nPress Enter to exit...");
  rl.close();
}

// Detect if launched without arguments (e.g., double-clicked .exe)
if (process.argv.length <= 2) {
  runInteractiveMode().catch(err => {
    console.error("Fatal error in interactive mode:", err);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
