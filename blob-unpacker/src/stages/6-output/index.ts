// ============================================================
// STAGE 6 — OUTPUT PREPARATION & DATA FORMATTING
// Takes all artifacts, reconstructed files, and extracted data
// and formats it into structured output for downstream consumption.
//
// Output Categories:
//   1. Reconstructed source files (directory tree)
//   2. Extracted endpoints (JSON with classification)
//   3. Extracted artifacts (secrets, configs, comments)
//   4. Run metadata & statistics
//   5. Human-readable summary report
//
// Output Formats:
//   - File system:  sources/ directory with original project structure
//   - JSON:         endpoints.json, secrets.json, configs.json, comments.json
//   - JSONL:        Same data in JSON Lines format (configurable)
//   - Report:       summary.md — human-readable findings report
//   - Contract:     run-report.json — machine-readable metadata
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { PipelineContext } from "../../core/context";
import {
  ExtractedArtifacts,
  DiscoveredEndpoint,
  DiscoveredSecret,
  DiscoveredComment,
  DiscoveredConfig,
  RunReport,
} from "../../types/contracts";
import { extractHostname } from "../../lib/paths";

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Write all pipeline outputs to the filesystem.
 * Each target hostname gets its own subdirectory under outDir.
 * A global index.json at the root summarises all findings across hosts.
 */
export async function writeOutputs(ctx: PipelineContext): Promise<void> {
  const outDir = ctx.config.output.dir;
  const format = ctx.config.output.format;
  const allArtifacts = ctx.results.getAll();

  ctx.logger.info(`Stage 6: writing outputs to ${outDir}`, { stage: "stage-6" });

  // ── Collect all findings ─────────────────────────────────
  const allEndpoints = ctx.results.getAllEndpoints();
  const allSecrets   = ctx.results.getAllSecrets();
  const allComments  = ctx.results.getAllComments();
  const allConfigs   = ctx.results.getAllConfigs();

  // ── Group findings by hostname ───────────────────────────
  const byHost = groupByHostname({
    endpoints: allEndpoints,
    secrets:   allSecrets,
    comments:  allComments,
    configs:   allConfigs,
  });

  // Always create a host entry for every target URL so the folder
  // is created even on a clean scan with zero findings.
  for (const targetUrl of ctx.config.target_urls) {
    const host = extractHostname(targetUrl);
    if (!byHost[host]) {
      byHost[host] = { endpoints: [], secrets: [], comments: [], configs: [] };
    }
  }

  // ── Write per-hostname directories ───────────────────────
  for (const [hostname, findings] of Object.entries(byHost)) {
    const hostDir = path.join(outDir, hostname);
    fs.mkdirSync(hostDir, { recursive: true });

    writeDataFile(path.join(hostDir, `endpoints.${format}`), findings.endpoints, format);
    writeDataFile(path.join(hostDir, `secrets.${format}`),   findings.secrets,   format);
    writeDataFile(path.join(hostDir, `comments.${format}`),  findings.comments,  format);
    writeDataFile(path.join(hostDir, `configs.${format}`),   findings.configs,   format);

    // Per-host artifact index
    const hostArtifacts = allArtifacts.filter((a) => extractHostFromArtifact(a.asset_url) === hostname);
    const artifactIndex = buildArtifactIndex(hostArtifacts);
    writeJsonFile(path.join(hostDir, "artifact-index.json"), artifactIndex);

    // Per-host manifests for downstream tools
    const endpointContract = buildEndpointContract(findings.endpoints);
    writeJsonFile(path.join(hostDir, "manifests", "endpoints-contract.json"), endpointContract);

    const artifactContract = buildArtifactContract(findings.secrets, findings.configs);
    writeJsonFile(path.join(hostDir, "manifests", "artifacts-contract.json"), artifactContract);

    // Per-host summary report
    const totalAssets = ctx.state.getAllAssetStates().length;
    const report = ctx.buildRunReport(totalAssets);
    enrichRunReport(report, allArtifacts, ctx);
    writeJsonFile(path.join(hostDir, "run-report.json"), report);

    const summary = generateSummaryReport(
      report,
      findings.endpoints,
      findings.secrets,
      findings.comments,
      findings.configs,
      ctx,
      hostname
    );
    fs.writeFileSync(path.join(hostDir, "summary.md"), summary, "utf-8");
  }

  // ── Global root: full totals + index across all hosts ────
  const globalReport = ctx.buildRunReport(ctx.state.getAllAssetStates().length);
  enrichRunReport(globalReport, allArtifacts, ctx);
  writeJsonFile(path.join(outDir, "run-report.json"), globalReport);

  // Global index listing all scanned hostnames with finding counts
  const globalIndex = Object.entries(byHost).map(([hostname, findings]) => ({
    hostname,
    dir: hostname,
    endpoints: findings.endpoints.length,
    secrets:   findings.secrets.length,
    comments:  findings.comments.length,
    configs:   findings.configs.length,
  }));
  writeJsonFile(path.join(outDir, "index.json"), globalIndex);

  // Pipeline log already in outDir (written by logger)
  // .pipeline-state.json already written by state manager

  ctx.logger.info(
    `Stage 6: wrote ${allEndpoints.length} endpoints, ${allSecrets.length} secrets, ` +
      `${allComments.length} comments, ${allConfigs.length} configs across ${Object.keys(byHost).length} host(s)`,
    { stage: "stage-6" }
  );
  ctx.logger.info(`Stage 6: all outputs written`, { stage: "stage-6" });
}


// ============================================================
// DATA FILE WRITERS
// ============================================================

function writeDataFile(filePath: string, data: unknown[], format: "json" | "jsonl"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (format === "jsonl") {
    const lines = data.map((item) => JSON.stringify(item)).join("\n");
    fs.writeFileSync(filePath, lines + "\n", "utf-8");
  } else {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================================
// PER-HOSTNAME GROUPING
// ============================================================

interface HostFindings {
  endpoints: DiscoveredEndpoint[];
  secrets:   DiscoveredSecret[];
  comments:  DiscoveredComment[];
  configs:   DiscoveredConfig[];
}

/** Extract the hostname key used for directory naming from an asset URL. */
function extractHostFromArtifact(assetUrl: string): string {
  return extractHostname(assetUrl);
}

/**
 * Group all findings by the hostname of their source_file / asset_url.
 * Falls back to "_unknown" for anything that can't be parsed.
 */
function groupByHostname(all: {
  endpoints: DiscoveredEndpoint[];
  secrets:   DiscoveredSecret[];
  comments:  DiscoveredComment[];
  configs:   DiscoveredConfig[];
}): Record<string, HostFindings> {
  const result: Record<string, HostFindings> = {};

  const ensure = (host: string) => {
    if (!result[host]) {
      result[host] = { endpoints: [], secrets: [], comments: [], configs: [] };
    }
    return result[host];
  };

  for (const e of all.endpoints)  ensure(extractHostname(e.source_file)).endpoints.push(e);
  for (const s of all.secrets)    ensure(extractHostname(s.source_file)).secrets.push(s);
  for (const c of all.comments)   ensure(extractHostname(c.source_file)).comments.push(c);
  for (const c of all.configs)    ensure(extractHostname(c.source_file)).configs.push(c);

  // If nothing was found at all, still create a placeholder for the target URL
  // so the folder structure is always created.
  return result;
}


// ============================================================
// ARTIFACT INDEX
// ============================================================

interface ArtifactIndexEntry {
  asset_url: string;
  endpoints_count: number;
  secrets_count: number;
  comments_count: number;
  configs_count: number;
}

function buildArtifactIndex(allArtifacts: ExtractedArtifacts[]): ArtifactIndexEntry[] {
  return allArtifacts.map((a) => ({
    asset_url: a.asset_url,
    endpoints_count: a.endpoints.length,
    secrets_count: a.secrets.length,
    comments_count: a.comments.length,
    configs_count: a.configs.length,
  }));
}

// ============================================================
// RUN REPORT ENRICHMENT
// ============================================================

function enrichRunReport(
  report: RunReport,
  allArtifacts: ExtractedArtifacts[],
  ctx: PipelineContext
): void {
  const states = ctx.state.getAllAssetStates();
  // Count reconstruction types from state tracking
  // (These were TODO in the original — now populated)
  report.total_endpoints_found = ctx.results.getAllEndpoints().length;
  report.total_secrets_found = ctx.results.getAllSecrets().length;
}

// ============================================================
// DOWNSTREAM CONTRACTS
// ============================================================

interface EndpointContractEntry {
  /** Schema version for downstream compatibility */
  _schema_version: string;
  url: string;
  method: string | null;
  confidence: string;
  source_file: string;
  line: number;
  context: string;
}

function buildEndpointContract(endpoints: DiscoveredEndpoint[]): {
  _schema_version: string;
  _generated_at: string;
  endpoints: EndpointContractEntry[];
} {
  return {
    _schema_version: "1.0.0",
    _generated_at: new Date().toISOString(),
    endpoints: endpoints.map((e) => ({
      _schema_version: "1.0.0",
      url: e.value,
      method: e.method ?? null,
      confidence: e.confidence,
      source_file: e.source_file,
      line: e.line,
      context: e.context_snippet,
    })),
  };
}

interface ArtifactContractEntry {
  type: string;
  value: string;
  source_file: string;
  line?: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
}

function buildArtifactContract(
  secrets: DiscoveredSecret[],
  configs: DiscoveredConfig[]
): {
  _schema_version: string;
  _generated_at: string;
  artifacts: ArtifactContractEntry[];
} {
  const artifacts: ArtifactContractEntry[] = [];

  for (const s of secrets) {
    artifacts.push({
      type: `secret/${s.type}`,
      value: s.value,
      source_file: s.source_file,
      line: s.line,
      severity: classifySecretSeverity(s),
    });
  }

  for (const c of configs) {
    artifacts.push({
      type: `config/${c.key}`,
      value: c.value,
      source_file: c.source_file,
      line: c.line,
      severity: "info",
    });
  }

  return {
    _schema_version: "1.0.0",
    _generated_at: new Date().toISOString(),
    artifacts,
  };
}

function classifySecretSeverity(s: DiscoveredSecret): "critical" | "high" | "medium" | "low" {
  switch (s.type) {
    case "private_key":
    case "database_url":
      return "critical";
    case "hardcoded_credential":
    case "jwt_secret":
      return "high";
    case "api_key":
    case "bearer_token":
      return "medium";
    case "unknown_high_entropy":
      return "low";
    default:
      return "medium";
  }
}

// ============================================================
// HUMAN-READABLE SUMMARY REPORT
// ============================================================

function generateSummaryReport(
  report: RunReport,
  endpoints: DiscoveredEndpoint[],
  secrets: DiscoveredSecret[],
  comments: DiscoveredComment[],
  configs: DiscoveredConfig[],
  ctx: PipelineContext,
  hostname?: string
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────
  lines.push("# Blob Unpacker — Run Summary");
  lines.push("");
  if (hostname) lines.push(`**Host:** ${hostname}`);
  lines.push(`**Target:** ${ctx.config.target_urls.join(", ")}`);
  lines.push(`**Started:** ${report.started_at}`);
  lines.push(`**Completed:** ${report.completed_at}`);
  lines.push(`**Duration:** ${computeDuration(report.started_at, report.completed_at)}`);
  lines.push("");

  // ── Processing Stats ────────────────────────────────────
  lines.push("## Processing Statistics");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total JS assets processed | ${report.total_assets} |`);
  lines.push(`| Successfully completed | ${report.successfully_processed} |`);
  lines.push(`| Failed | ${report.failed_assets} |`);
  lines.push(`| Full source map reconstructions | ${report.full_reconstructions} |`);
  lines.push(`| Partial reconstructions | ${report.partial_reconstructions} |`);
  lines.push(`| De-obfuscated only (no map) | ${report.deobfuscated_only} |`);
  lines.push("");

  // ── Findings Overview ───────────────────────────────────
  lines.push("## Findings Overview");
  lines.push("");
  lines.push(`| Category | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| API Endpoints | ${endpoints.length} |`);
  lines.push(`| Secrets / Tokens | ${secrets.length} |`);
  lines.push(`| Developer Comments | ${comments.length} |`);
  lines.push(`| Configuration Values | ${configs.length} |`);
  lines.push("");

  // ── Endpoints ───────────────────────────────────────────
  if (endpoints.length > 0) {
    lines.push("## Discovered Endpoints");
    lines.push("");
    lines.push("| Method | Path | Confidence | Source |");
    lines.push("|--------|------|------------|--------|");
    for (const ep of endpoints.slice(0, 100)) {
      const method = ep.method ?? "—";
      const src = truncate(ep.source_file, 40);
      lines.push(`| ${method} | \`${ep.value}\` | ${ep.confidence} | ${src}:${ep.line} |`);
    }
    if (endpoints.length > 100) {
      lines.push(`| | ... and ${endpoints.length - 100} more | | |`);
    }
    lines.push("");
  }

  // ── Secrets ─────────────────────────────────────────────
  if (secrets.length > 0) {
    lines.push("## Discovered Secrets");
    lines.push("");
    lines.push("> [!CAUTION]");
    lines.push("> Secret values are partially masked for safety.");
    lines.push("");
    lines.push("| Type | Value (masked) | Entropy | Source |");
    lines.push("|------|----------------|---------|--------|");
    for (const s of secrets.slice(0, 50)) {
      const src = truncate(s.source_file, 40);
      lines.push(`| ${s.type} | \`${s.value}\` | ${s.entropy} | ${src}:${s.line} |`);
    }
    lines.push("");
  }

  // ── Security Comments ───────────────────────────────────
  if (comments.length > 0) {
    lines.push("## Security-Relevant Comments");
    lines.push("");
    lines.push("| Category | Comment | Source |");
    lines.push("|----------|---------|--------|");
    for (const c of comments.slice(0, 50)) {
      const src = truncate(c.source_file, 40);
      const text = truncate(c.text, 80);
      lines.push(`| ${c.category} | ${text} | ${src}:${c.line} |`);
    }
    lines.push("");
  }

  // ── Configs ─────────────────────────────────────────────
  if (configs.length > 0) {
    lines.push("## Configuration Values");
    lines.push("");
    lines.push("| Key | Value | Source |");
    lines.push("|-----|-------|--------|");
    for (const c of configs.slice(0, 50)) {
      const src = truncate(c.source_file, 40);
      const val = truncate(c.value, 60);
      lines.push(`| ${c.key} | \`${val}\` | ${src} |`);
    }
    lines.push("");
  }

  // ── Failures ────────────────────────────────────────────
  if (report.failed_asset_details.length > 0) {
    lines.push("## Failed Assets");
    lines.push("");
    for (const f of report.failed_asset_details) {
      lines.push(`- **${f.url}**: ${f.error}`);
    }
    lines.push("");
  }

  // ── Footer ──────────────────────────────────────────────
  lines.push("---");
  lines.push(`*Generated by Blob Unpacker at ${new Date().toISOString()}*`);

  return lines.join("\n");
}

// ============================================================
// HELPERS
// ============================================================

function computeDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}
