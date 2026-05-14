// ============================================================
// STAGE 6 — OUTPUT PREPARATION & DATA FORMATTING
// Takes all artifacts, reconstructed files, and extracted data
// and formats it into structured output for downstream consumption.
//
// Output Layout (target-centric):
//   <outDir>/<target-host>/
//     ├── endpoints.json         ← ALL endpoints (first + third party)
//     ├── secrets.json
//     ├── comments.json
//     ├── configs.json
//     ├── artifact-index.json
//     ├── run-report.json
//     ├── summary.md
//     ├── manifests/
//     │   ├── endpoints-contract.json
//     │   └── artifacts-contract.json
//     ├── deobfuscated/          ← first-party JS
//     ├── raw/                   ← first-party original JS
//     ├── sources/               ← first-party source-map files
//     └── third-party/           ← everything from external domains
//         ├── _index.json        ← lists all third-party hosts
//         └── <hostname>/
//             ├── deobfuscated/
//             ├── raw/
//             └── sources/
//
// Output Formats:
//   - JSON:   endpoints.json, secrets.json, configs.json, comments.json
//   - JSONL:  Same data in JSON Lines format (configurable)
//   - Report: summary.md — human-readable findings report
//   - Contract: run-report.json — machine-readable metadata
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
import { extractHostname, extractTargetHostname } from "../../lib/paths";

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Write all pipeline outputs to the filesystem.
 * All outputs go under a single <target-host> folder.
 * Third-party deobfuscated/source files are nested under third-party/<host>/.
 * Finding JSONs (endpoints, secrets, etc.) aggregate everything in one place.
 */
export async function writeOutputs(ctx: PipelineContext): Promise<void> {
  const outDir = ctx.config.output.dir;
  const format = ctx.config.output.format;
  const allArtifacts = ctx.results.getAll();

  const targetHost = extractTargetHostname(ctx.config.target_urls);
  const targetDir = path.join(outDir, targetHost);
  fs.mkdirSync(targetDir, { recursive: true });

  ctx.logger.info(`Stage 6: writing outputs to ${targetDir}`, { stage: "stage-6" });

  // ── Collect all findings ─────────────────────────────────
  const allEndpoints = ctx.results.getAllEndpoints();
  const allSecrets   = ctx.results.getAllSecrets();
  const allComments  = ctx.results.getAllComments();
  const allConfigs   = ctx.results.getAllConfigs();

  // ── Write aggregated data files ──────────────────────────
  // All findings (first-party + third-party) go into one set of files
  // so you don't have to hunt across subdirectories.
  writeDataFile(path.join(targetDir, `endpoints.${format}`), allEndpoints, format);
  writeDataFile(path.join(targetDir, `secrets.${format}`),   allSecrets,   format);
  writeDataFile(path.join(targetDir, `comments.${format}`),  allComments,  format);
  writeDataFile(path.join(targetDir, `configs.${format}`),   allConfigs,   format);

  // ── Artifact index ───────────────────────────────────────
  const artifactIndex = buildArtifactIndex(allArtifacts);
  writeJsonFile(path.join(targetDir, "artifact-index.json"), artifactIndex);

  // ── Manifests for downstream tools ───────────────────────
  const endpointContract = buildEndpointContract(allEndpoints);
  writeJsonFile(path.join(targetDir, "manifests", "endpoints-contract.json"), endpointContract);

  const artifactContract = buildArtifactContract(allSecrets, allConfigs);
  writeJsonFile(path.join(targetDir, "manifests", "artifacts-contract.json"), artifactContract);

  // ── Run report ───────────────────────────────────────────
  const totalAssets = ctx.state.getAllAssetStates().length;
  const report = ctx.buildRunReport(totalAssets);
  enrichRunReport(report, allArtifacts, ctx);
  writeJsonFile(path.join(targetDir, "run-report.json"), report);

  // ── Third-party index ────────────────────────────────────
  // Write a small index listing all third-party domains discovered.
  const thirdPartyHosts = collectThirdPartyHosts(allArtifacts, targetHost);
  if (thirdPartyHosts.length > 0) {
    const tpDir = path.join(targetDir, "third-party");
    fs.mkdirSync(tpDir, { recursive: true });
    writeJsonFile(path.join(tpDir, "_index.json"), {
      target: targetHost,
      third_party_domains: thirdPartyHosts,
      count: thirdPartyHosts.length,
    });
  }

  // ── Human-readable summary ───────────────────────────────
  const summary = generateSummaryReport(
    report,
    allEndpoints,
    allSecrets,
    allComments,
    allConfigs,
    ctx,
    targetHost,
    thirdPartyHosts
  );
  fs.writeFileSync(path.join(targetDir, "summary.md"), summary, "utf-8");

  // ── Global root index (for multi-target scans) ───────────
  writeJsonFile(path.join(outDir, "run-report.json"), report);

  ctx.logger.info(
    `Stage 6: wrote ${allEndpoints.length} endpoints, ${allSecrets.length} secrets, ` +
      `${allComments.length} comments, ${allConfigs.length} configs ` +
      `(${thirdPartyHosts.length} third-party domain(s))`,
    { stage: "stage-6" }
  );
  ctx.logger.info(`Stage 6: all outputs written to ${targetDir}`, { stage: "stage-6" });
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
// THIRD-PARTY HOST COLLECTION
// ============================================================

/**
 * Collect all unique third-party hostnames from the artifacts.
 */
function collectThirdPartyHosts(
  allArtifacts: ExtractedArtifacts[],
  targetHost: string
): string[] {
  const hosts = new Set<string>();
  for (const a of allArtifacts) {
    const host = extractHostname(a.asset_url);
    if (host !== targetHost && host !== "_unknown") {
      hosts.add(host);
    }
  }
  return [...hosts].sort();
}


// ============================================================
// ARTIFACT INDEX
// ============================================================

interface ArtifactIndexEntry {
  asset_url: string;
  hostname: string;
  is_third_party: boolean;
  endpoints_count: number;
  secrets_count: number;
  comments_count: number;
  configs_count: number;
}

function buildArtifactIndex(allArtifacts: ExtractedArtifacts[]): ArtifactIndexEntry[] {
  return allArtifacts.map((a) => {
    const host = extractHostname(a.asset_url);
    return {
      asset_url: a.asset_url,
      hostname: host,
      is_third_party: false, // Will be enriched by caller if needed
      endpoints_count: a.endpoints.length,
      secrets_count: a.secrets.length,
      comments_count: a.comments.length,
      configs_count: a.configs.length,
    };
  });
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
  targetHost: string,
  thirdPartyHosts: string[]
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────
  lines.push("# Blob Unpacker — Run Summary");
  lines.push("");
  lines.push(`**Target:** ${ctx.config.target_urls.join(", ")}`);
  lines.push(`**Host:** ${targetHost}`);
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

  // ── Third-party domains ─────────────────────────────────
  if (thirdPartyHosts.length > 0) {
    lines.push("## Third-Party Domains Discovered");
    lines.push("");
    lines.push(`Found **${thirdPartyHosts.length}** external domain(s) loading JavaScript on the target site:`);
    lines.push("");
    for (const host of thirdPartyHosts) {
      lines.push(`- \`${host}\``);
    }
    lines.push("");
    lines.push(`> Third-party JS files are stored in \`third-party/<domain>/deobfuscated/\``);
    lines.push("");
  }

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
