// ============================================================
// BLOB UNPACKER — PIPELINE CONTEXT
// The shared brain passed to every stage. Holds config,
// structured logging, state persistence, and results store.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
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
    /**
     * When true, allow static Dean Edwards packer unpack.
     * Never executes code in node:vm. When false, skip packer unwrap.
     */
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
    /** Max response body size in bytes (SSRF/DoS guard) */
    max_response_bytes: number;
  };

  crawl?: {
    /** Max link-following depth (0 = entry page only) */
    max_depth: number;
    /** Max total pages to follow before stopping */
    max_pages: number;
    /** Enable JS-based chunk discovery (import(), webpack, etc.) */
    discover_chunks: boolean;
  };

  playwright?: {
    /** Enable Playwright headless browser scan (Phase 4) */
    enabled: boolean;
    /** Browser engine to use */
    browser: "chromium" | "firefox" | "webkit";
    /** Page load timeout in ms */
    timeout_ms: number;
    /** Navigation wait condition */
    wait_until: "networkidle" | "domcontentloaded" | "load";
    /** Run browser without visible UI */
    headless: boolean;
    /** Max pages to run through Playwright (subset of crawled pages) */
    max_pages: number;
  };

  wayback?: {
    /** Enable Wayback Machine CDX API discovery (Phase 5) */
    enabled: boolean;
    /** Max historical JS URLs to fetch per domain */
    max_results: number;
    /** Only fetch if the snapshot is within this many days old (0 = any age) */
    max_age_days: number;
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
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    max_response_bytes: 10 * 1024 * 1024,
  },
  crawl: {
    max_depth: 2,
    max_pages: 50,
    discover_chunks: true,
  },
  playwright: {
    enabled: false,
    browser: "chromium",
    timeout_ms: 30000,
    wait_until: "networkidle",
    headless: true,
    max_pages: 20,
  },
  wayback: {
    enabled: false,
    max_results: 200,
    max_age_days: 0,
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
  private emitter: EventEmitter;

  constructor(outputDir: string, emitter?: EventEmitter) {
    const logPath = path.join(outputDir, "pipeline.log.jsonl");
    fs.mkdirSync(outputDir, { recursive: true });
    this.logFile = fs.createWriteStream(logPath, { flags: "a" });
    this.emitter = emitter || new EventEmitter();
  }

  private write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    // Always write to file
    this.logFile?.write(line + "\n");
    // Emit event for real-time subscriptions (web API, etc.)
    this.emitter.emit("log", entry);
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

  getEmitter(): EventEmitter {
    return this.emitter;
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
  private persistChain: Promise<void> = Promise.resolve();

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
    // Atomic write: temp file then rename to avoid corrupt JSON on crash
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    try {
      fs.renameSync(tmp, this.statePath);
    } catch {
      // Windows cannot rename over an existing file
      fs.copyFileSync(tmp, this.statePath);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  /** Serialize state mutations so concurrent processAsset calls cannot clobber updates. */
  private enqueuePersist(mutate: () => void): void {
    this.persistChain = this.persistChain
      .then(() => {
        mutate();
        this.persist();
      })
      .catch(() => {
        // Keep chain alive after a failed write
      });
  }

  /** Returns true if this content hash has already been fully processed */
  isHashProcessed(hash: string): boolean {
    return this.state.processed_hashes[hash] === true;
  }

  markHashProcessed(hash: string): void {
    this.enqueuePersist(() => {
      this.state.processed_hashes[hash] = true;
    });
  }

  setAssetStatus(url: string, status: AssetProcessingStatus, error?: string): void {
    this.enqueuePersist(() => {
      const existing = this.state.asset_states[url] || {};
      this.state.asset_states[url] = {
        ...existing,
        url,
        status,
        ...(error ? { error } : {}),
        ...(status === "complete" ? { completed_at: new Date().toISOString() } : {}),
      };
    });
  }

  setAssetReconstructionType(
    url: string,
    type: "full" | "partial" | "none" | "paths_only"
  ): void {
    this.enqueuePersist(() => {
      const existing = this.state.asset_states[url] || { url, status: "queued" };
      const normalized = type === "paths_only" ? "none" : type;
      this.state.asset_states[url] = { ...existing, reconstruction_type: normalized };
    });
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
  private emitter: EventEmitter;

  constructor(userConfig: Partial<PipelineConfig> = {}, emitter?: EventEmitter) {
    // Deep clone defaults then merge so nested objects are not shared
    const merged = deepMerge(
      structuredClone(DEFAULT_CONFIG) as PipelineConfig,
      userConfig
    );
    validateConfig(merged);
    this.config = Object.freeze(merged);
    this.startedAt = new Date().toISOString();
    this.emitter = emitter || new EventEmitter();

    // Ensure root output directory exists
    const outDir = this.config.output.dir;
    fs.mkdirSync(outDir, { recursive: true });

    // Derive the target-specific subdirectory for logs & state.
    // This keeps each target's state isolated so re-runs on the same
    // target don't skip assets due to stale cross-run hashes, and logs
    // don't accumulate across different targets/runs.
    const targetHost = extractTargetHostnameFromConfig(this.config);
    const targetDir = path.join(outDir, targetHost);
    fs.mkdirSync(targetDir, { recursive: true });

    this.logger = new Logger(targetDir, this.emitter);
    this.state = new StateManager(targetDir);
    this.results = new ResultsStore();
  }

  getEmitter(): EventEmitter {
    return this.emitter;
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

/**
 * Derive the target hostname from config for use as the output subdirectory.
 * Mirrors the sanitization in lib/paths.ts so directory names stay consistent.
 */
function extractTargetHostnameFromConfig(config: PipelineConfig): string {
  const url = config.target_urls[0];
  if (!url) return "_unknown";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 100) || "_unknown";
  } catch {
    return "_unknown";
  }
}

function deepMerge<T extends object>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as Array<keyof T>) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const val = override[key];
    if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = deepMerge(
        (result[key] ?? {}) as object,
        val as object
      ) as T[keyof T];
    } else if (val !== undefined) {
      result[key] = val as T[keyof T];
    }
  }
  return result;
}

function validateConfig(config: PipelineConfig): void {
  const clampInt = (n: number, min: number, max: number, fallback: number): number => {
    if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  config.http.max_concurrent = clampInt(config.http.max_concurrent, 1, 64, 5);
  config.http.timeout_ms = clampInt(config.http.timeout_ms, 1000, 300_000, 15_000);
  config.http.delay_between_ms = clampInt(config.http.delay_between_ms, 0, 60_000, 300);
  if (!Number.isFinite(config.http.max_response_bytes) || config.http.max_response_bytes <= 0) {
    config.http.max_response_bytes = 10 * 1024 * 1024;
  }
  config.http.max_response_bytes = Math.min(
    config.http.max_response_bytes,
    100 * 1024 * 1024
  );

  config.deobfuscation.max_depth = clampInt(config.deobfuscation.max_depth, 1, 20, 5);

  if (config.crawl) {
    config.crawl.max_depth = clampInt(config.crawl.max_depth, 0, 20, 2);
    config.crawl.max_pages = clampInt(config.crawl.max_pages, 1, 10_000, 50);
  }

  if (!Number.isFinite(config.extraction.min_secret_entropy)) {
    config.extraction.min_secret_entropy = 4.5;
  }
}
