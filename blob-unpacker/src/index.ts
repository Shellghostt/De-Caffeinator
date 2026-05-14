// ============================================================
// BLOB UNPACKER — ENTRY POINT (CLI)
//
// Usage:
//   npx ts-node src/index.ts <url> [options]
//
// Examples:
//   npx ts-node src/index.ts https://example.com
//   npx ts-node src/index.ts https://example.com -o ./results
//   npx ts-node src/index.ts https://example.com --depth 3 --pages 100
//   npx ts-node src/index.ts https://example.com --format jsonl --concurrency 5
//   npx ts-node src/index.ts https://example.com --timeout 30000 --no-chunks
// ============================================================

import { PipelineContext, PipelineConfig } from "./core/context";
import { AssetQueue } from "./core/queue";
import { PipelineOrchestrator, PipelineStages } from "./core/pipeline";
import { runIngestion, IngestionOptions } from "./stages/1-ingestion";
import { detectMap } from "./stages/2-map-detection";
import { reconstruct } from "./stages/3-reconstruction";
import { deobfuscate } from "./stages/4-deobfuscation";
import { extract } from "./stages/5-extraction";

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
// CLI ARGUMENT PARSER
// ----------------------------------------------------------

function parseArgs(argv: string[]): Partial<PipelineConfig> & { _help?: boolean } {
  // Strip node and script path
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { _help: true } as any;
  }

  const urls: string[] = [];
  const parsedFlags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (arg === "--no-files" || arg === "--no-chunks") {
        parsedFlags[arg] = true;
        i++;
      } else if (arg.includes("=")) {
        const [key, ...rest] = arg.split("=");
        parsedFlags[key] = rest.join("=");
        i++;
      } else {
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          parsedFlags[arg] = args[i + 1];
          i += 2;
        } else {
          parsedFlags[arg] = true;
          i++;
        }
      }
    } else {
      urls.push(arg);
      i++;
    }
  }

  if (urls.length === 0) {
    return { _help: true } as any;
  }

  const getFlag = (long: string, short?: string): string | undefined => {
    const val = parsedFlags[long] ?? (short ? parsedFlags[short] : undefined);
    return typeof val === "string" ? val : undefined;
  };

  const hasFlag = (long: string, short?: string): boolean => {
    return parsedFlags[long] !== undefined || (short ? parsedFlags[short] !== undefined : false);
  };

  const config: Partial<PipelineConfig> = {
    input_mode: "crawl",
    target_urls: urls,
  };

  // Output options
  const outDir = getFlag("--output", "-o");
  const format = getFlag("--format", "-f");
  const noFiles = hasFlag("--no-files");
  config.output = {
    dir: outDir ?? "./output",
    write_source_files: !noFiles,
    format: (format === "jsonl" ? "jsonl" : "json") as "json" | "jsonl",
  };

  // HTTP options
  const timeout = getFlag("--timeout", "-t");
  const concurrency = getFlag("--concurrency", "-c");
  const delay = getFlag("--delay");
  const ua = getFlag("--user-agent");
  config.http = {
    timeout_ms: timeout && !isNaN(parseInt(timeout, 10)) ? parseInt(timeout, 10) : 15000,
    max_concurrent: concurrency && !isNaN(parseInt(concurrency, 10)) ? parseInt(concurrency, 10) : 5,
    delay_between_ms: delay && !isNaN(parseInt(delay, 10)) ? parseInt(delay, 10) : 300,
    user_agent: ua ?? "BlobUnpacker/1.0",
  };

  // Crawl options
  const depth = getFlag("--depth", "-d");
  const pages = getFlag("--pages", "-p");
  const noChunks = hasFlag("--no-chunks");
  config.crawl = {
    max_depth: depth && !isNaN(parseInt(depth, 10)) ? parseInt(depth, 10) : 2,
    max_pages: pages && !isNaN(parseInt(pages, 10)) ? parseInt(pages, 10) : 50,
    discover_chunks: !noChunks,
  };

  // De-obfuscation options
  const maxDeobfDepth = getFlag("--deobf-depth");
  config.deobfuscation = {
    max_depth: maxDeobfDepth && !isNaN(parseInt(maxDeobfDepth, 10)) ? parseInt(maxDeobfDepth, 10) : 5,
    eval_sandbox: true,
    string_array_threshold: 10,
  };

  // Extraction options
  const entropy = getFlag("--entropy");
  config.extraction = {
    endpoint_patterns: [],
    secret_patterns: [],
    min_secret_entropy: entropy && !isNaN(parseFloat(entropy)) ? parseFloat(entropy) : 4.5,
  };

  return config;
}

function printUsage(): void {
  const usage = `
╔══════════════════════════════════════════════════════════════╗
║                      BLOB UNPACKER                         ║
║    JavaScript Reverse Engineering & Asset Analysis Tool     ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  npx ts-node src/index.ts <url> [options]

ARGUMENTS:
  <url>                    Target URL to analyze (required)

OUTPUT OPTIONS:
  -o, --output <dir>       Output directory (default: ./output)
  -f, --format <fmt>       Data format: json or jsonl (default: json)
      --no-files           Don't write source/deobfuscated files to disk

CRAWL OPTIONS:
  -d, --depth <n>          Max crawl depth for link following (default: 2)
  -p, --pages <n>          Max pages to crawl (default: 50)
      --no-chunks          Disable dynamic chunk discovery

HTTP OPTIONS:
  -t, --timeout <ms>       HTTP request timeout in ms (default: 15000)
  -c, --concurrency <n>    Max concurrent requests (default: 5)
      --delay <ms>         Delay between requests in ms (default: 300)
      --user-agent <str>   Custom User-Agent string

ANALYSIS OPTIONS:
      --deobf-depth <n>    Max de-obfuscation passes (default: 5)
      --entropy <n>        Min entropy for secret detection (default: 4.5)

EXAMPLES:
  npx ts-node src/index.ts https://example.com
  npx ts-node src/index.ts https://example.com -o ./results
  npx ts-node src/index.ts https://example.com --depth 3 --pages 100
  npx ts-node src/index.ts https://example.com --format jsonl -c 10
  npx ts-node src/index.ts https://example.com --no-chunks --timeout 30000
`;
  console.log(usage);
}

// ----------------------------------------------------------
// MAIN
// ----------------------------------------------------------

if (require.main === module) {
  const config = parseArgs(process.argv);

  if ((config as any)._help) {
    printUsage();
    process.exit(0);
  }

  console.log(`\n🔍 Blob Unpacker starting...`);
  console.log(`   Target:  ${config.target_urls?.join(", ")}`);
  console.log(`   Output:  ${config.output?.dir}`);
  console.log(`   Depth:   ${config.crawl?.max_depth}`);
  console.log(`   Pages:   ${config.crawl?.max_pages}\n`);

  run(config).catch((err) => {
    console.error("\n❌ Fatal pipeline error:", err);
    process.exit(1);
  });
}
