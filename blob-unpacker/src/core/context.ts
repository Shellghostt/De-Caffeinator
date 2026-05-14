// ============================================================
// BLOB UNPACKER — PIPELINE CONTEXT
// The shared brain passed to every stage. Holds config,
// structured logging, state persistence, and results store.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import {
  AssetState,
  AssetProcessingStatus,
  ExtractedArtifacts,
  RunReport,
} from "../types/contracts";

// ----------------------------------------------------------
// CONFIG SCHEMA
// ----------------------------------------------------------

export interface PipelineConfig {
  /** Seed URLs: either JS asset URLs directly, or entry HTML pages */
  target_urls: string[];
  input_mode: "spider" | "crawl";

  map_detection: {
    try_comment: boolean;
    try_header: boolean;
    try_inferred_path: boolean;
    /** Skip embedded maps larger than this (MB) */
    inline_map_limit_mb: number;
  };

  deobfuscation: {
    /** Maximum recursive de-obfuscation passes per asset */
    max_depth: number;
    /** Enable sandboxed eval for packed loader unwrapping */
    eval_sandbox: boolean;
    /** Min array length before attempting string array resolution */
    string_array_threshold: number;
  };

  extraction: {
    /** Additional regex patterns for endpoint discovery */
    endpoint_patterns: string[];
    /** Additional regex patterns for secret detection */
    secret_patterns: string[];
    /** Shannon entropy threshold for secret classification */
    min_secret_entropy: number;
  };

  http: {
    timeout_ms: number;
    /** Max concurrent fetches across the whole pipeline */
    max_concurrent: number;
    /** Delay between requests to the same host (ms) */
    delay_between_ms: number;
    user_agent: string;
  };

  crawl?: {
    /** Max link-following depth (0 = entry page only) */
    max_depth: number;
    /** Max total pages to follow before stopping */
    max_pages: number;
    /** Enable JS-based chunk discovery (import(), webpack, etc.) */
    discover_chunks: boolean;
  };

  output: {
    /** Root directory for all output */
    dir: string;
    write_source_files: boolean;
    format: "json" | "jsonl";
  };
}

export const DEFAULT_CONFIG: PipelineConfig = {
  target_urls: [],
  input_mode: "crawl",
  map_detection: {
    try_comment: true,
    try_header: true,
    try_inferred_path: true,
    inline_map_limit_mb: 10,
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
  http: {
    timeout_ms: 15000,
    max_concurrent: 5,
    delay_between_ms: 300,
    user_agent: "BlobUnpacker/1.0",
  },
  crawl: {
    max_depth: 2,
    max_pages: 50,
    discover_chunks: true,
  },
  output: {
    dir: "./output",
    write_source_files: true,
    format: "json",
  },
};

// ----------------------------------------------------------
// LOGGER
// ----------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  asset_url?: string;
  stage?: string;
  [key: string]: unknown;
}

export class Logger {
  private logFile: fs.WriteStream | null = null;

  constructor(outputDir: string) {
    const logPath = path.join(outputDir, "pipeline.log.jsonl");
    fs.mkdirSync(outputDir, { recursive: true });
    this.logFile = fs.createWriteStream(logPath, { flags: "a" });
  }

  private write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    // Always write to file
    this.logFile?.write(line + "\n");
    // Console: suppress debug in production
    if (entry.level !== "debug") {
      const prefix = `[${entry.level.toUpperCase()}]`;
      const tag = entry.asset_url ? ` (${entry.asset_url})` : "";
      console.log(`${prefix}${tag} ${entry.message}`);
    }
  }

  log(level: LogLevel, message: string, meta?: Partial<LogEntry>): void {
    this.write({ level, message, timestamp: new Date().toISOString(), ...meta });
  }

  info(message: string, meta?: Partial<LogEntry>): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Partial<LogEntry>): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Partial<LogEntry>): void {
    this.log("error", message, meta);
  }

  debug(message: string, meta?: Partial<LogEntry>): void {
    this.log("debug", message, meta);
  }

  close(): void {
    this.logFile?.end();
  }
}

// ----------------------------------------------------------
// STATE MANAGER (resumability)
// ----------------------------------------------------------

interface PersistedState {
  processed_hashes: Record<string, boolean>;
  asset_states: Record<string, AssetState>;
  started_at: string;
}

export class StateManager {
  private statePath: string;
  private state: PersistedState;

  constructor(outputDir: string) {
    this.statePath = path.join(outputDir, ".pipeline-state.json");
    this.state = this.load();
  }

  private load(): PersistedState {
    if (fs.existsSync(this.statePath)) {
      try {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        return JSON.parse(raw);
      } catch {
        // Corrupt state file — start fresh
      }
    }
    return {
      processed_hashes: {},
      asset_states: {},
      started_at: new Date().toISOString(),
    };
  }

  private persist(): void {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  /** Returns true if this content hash has already been fully processed */
  isHashProcessed(hash: string): boolean {
    return this.state.processed_hashes[hash] === true;
  }

  markHashProcessed(hash: string): void {
    this.state.processed_hashes[hash] = true;
    this.persist();
  }

  setAssetStatus(url: string, status: AssetProcessingStatus, error?: string): void {
    this.state.asset_states[url] = {
      url,
      status,
      ...(error ? { error } : {}),
      ...(status === "complete" ? { completed_at: new Date().toISOString() } : {}),
    };
    this.persist();
  }

  getAssetStatus(url: string): AssetState | undefined {
    return this.state.asset_states[url];
  }

  getAllAssetStates(): AssetState[] {
    return Object.values(this.state.asset_states);
  }

  getStartedAt(): string {
    return this.state.started_at;
  }
}

// ----------------------------------------------------------
// RESULTS STORE (in-memory aggregation)
// ----------------------------------------------------------

export class ResultsStore {
  private artifacts: ExtractedArtifacts[] = [];

  add(artifact: ExtractedArtifacts): void {
    this.artifacts.push(artifact);
  }

  getAll(): ExtractedArtifacts[] {
    return [...this.artifacts];
  }

  /** Flatten all endpoints across all assets, deduplicated by value */
  getAllEndpoints() {
    const seen = new Set<string>();
    return this.artifacts.flatMap((a) =>
      a.endpoints.filter((e) => {
        if (seen.has(e.value)) return false;
        seen.add(e.value);
        return true;
      })
    );
  }

  /** Flatten all secrets across all assets */
  getAllSecrets() {
    return this.artifacts.flatMap((a) => a.secrets);
  }

  /** Flatten all comments across all assets */
  getAllComments() {
    return this.artifacts.flatMap((a) => a.comments);
  }

  /** Flatten all configs across all assets */
  getAllConfigs() {
    return this.artifacts.flatMap((a) => a.configs);
  }
}

// ----------------------------------------------------------
// PIPELINE CONTEXT (the object passed to every stage)
// ----------------------------------------------------------

export class PipelineContext {
  readonly config: Readonly<PipelineConfig>;
  readonly logger: Logger;
  readonly state: StateManager;
  readonly results: ResultsStore;
  readonly startedAt: string;

  constructor(userConfig: Partial<PipelineConfig> = {}) {
    // Deep merge user config over defaults
    this.config = Object.freeze(deepMerge(DEFAULT_CONFIG, userConfig));
    this.startedAt = new Date().toISOString();

    // Ensure output directories exist
    const outDir = this.config.output.dir;
    for (const sub of ["sources", "deobfuscated", "manifests"]) {
      fs.mkdirSync(path.join(outDir, sub), { recursive: true });
    }

    this.logger = new Logger(outDir);
    this.state = new StateManager(outDir);
    this.results = new ResultsStore();
  }

  buildRunReport(totalAssets: number): RunReport {
    const allStates = this.state.getAllAssetStates();
    const failed = allStates.filter((s) => s.status === "failed");
    const complete = allStates.filter((s) => s.status === "complete");

    return {
      started_at: this.startedAt,
      completed_at: new Date().toISOString(),
      total_assets: totalAssets,
      successfully_processed: complete.length,
      failed_assets: failed.length,
      // These will be populated by Stage 6
      full_reconstructions: 0,
      partial_reconstructions: 0,
      deobfuscated_only: 0,
      total_endpoints_found: this.results.getAllEndpoints().length,
      total_secrets_found: this.results.getAllSecrets().length,
      failed_asset_details: failed.map((s) => ({
        url: s.url,
        error: s.error ?? "Unknown error",
      })),
    };
  }

  teardown(): void {
    this.logger.close();
  }
}

// ----------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key in override) {
    const val = override[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = deepMerge(result[key] as object, val as object) as T[typeof key];
    } else if (val !== undefined) {
      result[key] = val as T[typeof key];
    }
  }
  return result;
}
