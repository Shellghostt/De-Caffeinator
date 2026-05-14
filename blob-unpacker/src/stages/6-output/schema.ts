// ============================================================
// STAGE 6 — OUTPUT SCHEMA DEFINITIONS
// Well-defined contracts for downstream module consumption.
// All schemas are versioned for backward compatibility.
//
// Downstream consumers:
//   - Source Auditor (expects endpoints-contract.json)
//   - Vulnerability Detection (expects artifacts-contract.json)
//   - Dashboard/UI (expects run-report.json + artifact-index.json)
// ============================================================

/**
 * Schema version: 1.0.0
 *
 * ## endpoints-contract.json
 * ```json
 * {
 *   "_schema_version": "1.0.0",
 *   "_generated_at": "ISO-8601",
 *   "endpoints": [
 *     {
 *       "url": "/api/users",
 *       "method": "GET" | null,
 *       "confidence": "high" | "medium" | "low",
 *       "source_file": "src/api/client.ts",
 *       "line": 42,
 *       "context": "... surrounding code ..."
 *     }
 *   ]
 * }
 * ```
 *
 * ## artifacts-contract.json
 * ```json
 * {
 *   "_schema_version": "1.0.0",
 *   "_generated_at": "ISO-8601",
 *   "artifacts": [
 *     {
 *       "type": "secret/api_key" | "secret/jwt_secret" | "config/apiUrl",
 *       "value": "masked value",
 *       "source_file": "src/config.ts",
 *       "line": 15,
 *       "severity": "critical" | "high" | "medium" | "low" | "info"
 *     }
 *   ]
 * }
 * ```
 *
 * ## run-report.json
 * See RunReport in types/contracts.ts
 *
 * ## artifact-index.json
 * ```json
 * [
 *   {
 *     "asset_url": "https://example.com/main.js",
 *     "endpoints_count": 12,
 *     "secrets_count": 2,
 *     "comments_count": 5,
 *     "configs_count": 8
 *   }
 * ]
 * ```
 *
 * ## Output Directory Structure
 * ```
 * output/
 * ├── endpoints.json          # All discovered endpoints
 * ├── secrets.json            # All discovered secrets (masked)
 * ├── comments.json           # Security-relevant developer comments
 * ├── configs.json            # Configuration values found in code
 * ├── artifact-index.json     # Per-asset finding counts
 * ├── run-report.json         # Machine-readable run metadata
 * ├── summary.md              # Human-readable findings report
 * ├── manifests/
 * │   ├── endpoints-contract.json   # Versioned contract for Source Auditor
 * │   └── artifacts-contract.json   # Versioned contract for Vuln Detection
 * ├── sources/
 * │   └── <content-hash>/     # Reconstructed source files per asset
 * │       ├── src/
 * │       │   └── App.tsx
 * │       └── _file_index.txt
 * ├── deobfuscated/           # De-obfuscated JS output
 * └── pipeline.log            # Full pipeline execution log
 * ```
 */

// Export the current schema version for use by writers
export const SCHEMA_VERSION = "1.0.0";

// Re-export the output writer
export { writeOutputs } from "./index";
