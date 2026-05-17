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

// ----------------------------------------------------------
// PIPELINE RUNNER (exported for programmatic use)
// ----------------------------------------------------------

export async function run(
  userConfig: Partial<PipelineConfig> = {},
  ingestionOpts: IngestionOptions = {}
): Promise<void> {
  const ctx = new PipelineContext(userConfig);
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
  .option("--user-agent <str>", "Custom User-Agent string", "BlobUnpacker/1.0")

  // ── Analysis Options ────────────────────────────────────
  .option("--deobf-depth <n>", "Max de-obfuscation passes", "5")
  .option("--entropy <n>", "Min entropy for secret detection", "4.0")

  // ── Preset Profiles ─────────────────────────────────────
  .option("--quick", "Quick scan: entry page only, no chunk discovery")
  .option("--stealth", "Stealth mode: low concurrency, high delays")
  .option("--deep", "Deep recon: max depth, max pages, low entropy")

  // ── Action ──────────────────────────────────────────────
  .action(async (url: string, opts: Record<string, any>) => {
    printBanner();

    // Normalize URL
    if (!url.startsWith("http")) {
      const isLocal =
        url.startsWith("localhost") ||
        url.startsWith("127.0.0.1") ||
        url.startsWith("[::1]");
      url = (isLocal ? "http://" : "https://") + url;
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
        timeout_ms: parseInt(opts.timeout, 10),
        max_concurrent: parseInt(opts.concurrency, 10),
        delay_between_ms: parseInt(opts.delay, 10),
        user_agent: opts.userAgent,
      },
      crawl: {
        max_depth: parseInt(opts.depth, 10),
        max_pages: parseInt(opts.pages, 10),
        discover_chunks: opts.chunks !== false,
      },
      deobfuscation: {
        max_depth: parseInt(opts.deobfDepth, 10),
        eval_sandbox: true,
        string_array_threshold: 10,
      },
      extraction: {
        endpoint_patterns: [],
        secret_patterns: [],
        min_secret_entropy: parseFloat(opts.entropy),
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

  let url = await rl.question("Enter the Target URL (e.g., https://example.com): ");
  if (!url || url.trim() === "") {
    console.log("❌ URL is required.");
    await rl.question("\nPress Enter to exit...");
    rl.close();
    process.exit(1);
  }

  // Normalize URL
  if (!url.startsWith("http")) {
    const isLocal =
      url.startsWith("localhost") ||
      url.startsWith("127.0.0.1") ||
      url.startsWith("[::1]");
    url = (isLocal ? "http://" : "https://") + url;
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
      timeout_ms: 20000,
      max_concurrent: 5,
      delay_between_ms: 300,
      user_agent: "BlobUnpacker/1.0",
    },
    crawl: {
      max_depth: 3,
      max_pages: 100,
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
      min_secret_entropy: 4.0,
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
