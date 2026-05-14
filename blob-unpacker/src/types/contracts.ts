// ============================================================
// BLOB UNPACKER — DATA CONTRACTS
// These interfaces define the exact shape of data as it flows
// between pipeline stages. Never bypass these types.
// ============================================================

// ----------------------------------------------------------
// STAGE 1 OUTPUT → Stage 2 Input
// ----------------------------------------------------------

export type AssetType = "main_bundle" | "chunk" | "vendor" | "inline" | "unknown";

export interface AssetRecord {
  /** Fully normalized URL (no fragments, resolved relative paths) */
  url: string;
  /** The page or entry point where this asset was discovered */
  origin_page: string;
  /** SHA-256 hash of the raw fetched content — used for deduplication */
  content_hash: string;
  /** Classification determines processing priority */
  asset_type: AssetType;
  /** The raw JavaScript source text */
  raw_content: string;
  /** HTTP response headers from the fetch — needed for SourceMap header detection */
  fetch_headers: Record<string, string>;
  /** Timestamp when this asset was fetched */
  fetched_at: string;
  /** Discovery order (0-based) — tracks when this asset was found relative to others */
  load_order?: number;
}

// ----------------------------------------------------------
// STAGE 2 OUTPUT → Stage 3 or Stage 4 Input
// ----------------------------------------------------------

export type MapSource =
  | "comment"           // //# sourceMappingURL=...
  | "header"            // SourceMap: or X-SourceMap: HTTP headers
  | "inferred"          // Heuristic: tried appending .map to URL
  | "embedded_data_uri" // data:application/json;base64,... inline
  | null;               // No map found

export interface AssetWithMapInfo extends AssetRecord {
  /** The resolved URL of the source map, or null if none found */
  map_url: string | null;
  /** Which detection strategy found the map */
  map_source: MapSource;
  /** Raw content of the .map file if already fetched (e.g. embedded data URI) */
  map_content?: string;
}

// ----------------------------------------------------------
// STAGE 3 OUTPUT → Stage 5 Input (and partial chunks → Stage 4)
// ----------------------------------------------------------

export type ReconstructionCoverage = "full" | "partial" | "paths_only";

export interface ReconstructedFile {
  /** Original source path as found in the map (e.g. src/components/Auth.tsx) */
  path: string;
  /** Full source content, if available */
  content: string;
}

export interface ReconstructedSource {
  asset_url: string;
  /** All recovered source files */
  files: ReconstructedFile[];
  /** How complete the reconstruction was */
  coverage: ReconstructionCoverage;
  /**
   * Minified JS chunks that could not be reconstructed from the map.
   * These are routed to Stage 4 for de-obfuscation.
   * This is what enables the Stage 3 + Stage 4 overlap.
   */
  unmapped_minified_chunks: string[];
}

// ----------------------------------------------------------
// STAGE 4 OUTPUT → Stage 5 Input (or loops back into Stage 4)
// ----------------------------------------------------------

export type DeobfuscationTechnique =
  | "beautify"
  | "webpack_split"
  | "eval_unpack"
  | "string_array_resolve"
  | "hex_call_resolve"
  | "constant_fold"
  | "unicode_decode"
  | "dead_code_eliminate"
  | "control_flow_unflatten"
  | "iife_alias_resolve"
  | "library_detect"
  | "context_rename";

export interface WebpackModule {
  /** Module ID as used in the Webpack registry (numeric or string) */
  id: string;
  /** Extracted and beautified content of this module */
  content: string;
}

export interface DeobfuscatedAsset {
  asset_url: string;
  /** The full, readable JavaScript after all transformations */
  readable_js: string;
  /** The original minified JS before any transformations (for raw/ output) */
  original_js?: string;
  /** Individual Webpack modules, if the bundle was split */
  modules: WebpackModule[];
  /** Ordered list of transformations applied in this pass */
  techniques_applied: DeobfuscationTechnique[];
  /**
   * Recursive loop control.
   * depth: how many de-obfuscation passes have been applied.
   * still_packed: if true AND depth < MAX_DEPTH, route back into Stage 4.
   */
  depth: number;
  still_packed: boolean;
}

// ----------------------------------------------------------
// STAGE 5 OUTPUT → Stage 6 Input
// ----------------------------------------------------------

export type SecretType =
  | "api_key"
  | "jwt_secret"
  | "bearer_token"
  | "database_url"
  | "hardcoded_credential"
  | "private_key"
  | "unknown_high_entropy";

export type CommentCategory = "todo" | "fixme" | "hack" | "bypass" | "debug" | "note";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface DiscoveredEndpoint {
  value: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS";
  confidence: ConfidenceLevel;
  source_file: string;
  line: number;
  /** Surrounding code context (a few lines) */
  context_snippet: string;
}

export interface DiscoveredSecret {
  type: SecretType;
  value: string;
  /** Shannon entropy score — higher = more likely a real secret */
  entropy: number;
  context_snippet: string;
  source_file: string;
  line: number;
}

export interface DiscoveredComment {
  text: string;
  category: CommentCategory;
  source_file: string;
  line: number;
}

export interface DiscoveredConfig {
  key: string;
  value: string;
  source_file: string;
  line?: number;
}

export interface ExtractedArtifacts {
  asset_url: string;
  endpoints: DiscoveredEndpoint[];
  secrets: DiscoveredSecret[];
  comments: DiscoveredComment[];
  configs: DiscoveredConfig[];
}

// ----------------------------------------------------------
// PIPELINE STATE — used by Context for resumability
// ----------------------------------------------------------

export type AssetProcessingStatus =
  | "queued"
  | "fetching"
  | "detecting_map"
  | "reconstructing"
  | "deobfuscating"
  | "extracting"
  | "complete"
  | "failed";

export interface AssetState {
  url: string;
  content_hash?: string;
  status: AssetProcessingStatus;
  error?: string;
  completed_at?: string;
}

// ----------------------------------------------------------
// RUN REPORT — final metadata written to run-report.json
// ----------------------------------------------------------

export interface RunReport {
  started_at: string;
  completed_at: string;
  total_assets: number;
  successfully_processed: number;
  failed_assets: number;
  full_reconstructions: number;
  partial_reconstructions: number;
  deobfuscated_only: number;
  total_endpoints_found: number;
  total_secrets_found: number;
  failed_asset_details: Array<{ url: string; error: string }>;
}
