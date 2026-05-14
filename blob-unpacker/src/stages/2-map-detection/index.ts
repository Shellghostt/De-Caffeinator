// ============================================================
// STAGE 2 — SOURCE MAP DETECTION (Entry Point)
// Runs three detection strategies in priority order:
//   1. Comment scan (most reliable, zero extra requests)
//   2. Header inspection (zero extra requests)
//   3. Path inference (HEAD requests — conservative)
// Stops at the first hit.
// ============================================================

import { AssetRecord, AssetWithMapInfo } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { scanForMapComment } from "./comment-scanner";
import { inspectHeaders } from "./header-inspector";
import { inferMapPath } from "./path-inferrer";
import { fetchUrl } from "../../lib/http";

export async function detectMap(
  asset: AssetRecord,
  ctx: PipelineContext
): Promise<AssetWithMapInfo> {
  ctx.logger.info(`Stage 2: detecting source map for ${asset.url}`, {
    stage: "stage-2",
    asset_url: asset.url,
  });

  // ── Strategy 1: Inline comment ───────────────────────────
  if (ctx.config.map_detection.try_comment) {
    const result = scanForMapComment(asset.raw_content, asset.url);
    if (result.found && result.url) {
      // Data URI: map is already decoded, no fetch needed
      if (result.isDataUri && result.embeddedContent) {
        const limitBytes = ctx.config.map_detection.inline_map_limit_mb * 1024 * 1024;
        if (result.embeddedContent.length > limitBytes) {
          ctx.logger.warn(`Stage 2: embedded map exceeds size limit, skipping`, {
            stage: "stage-2",
            asset_url: asset.url,
          });
        } else {
          ctx.logger.info(`Stage 2: found embedded data URI map`, {
            stage: "stage-2",
            asset_url: asset.url,
          });
          return {
            ...asset,
            map_url: result.url,
            map_source: "embedded_data_uri",
            map_content: result.embeddedContent,
          };
        }
      } else {
        // External map URL from comment
        ctx.logger.info(`Stage 2: found map via comment → ${result.url}`, {
          stage: "stage-2",
          asset_url: asset.url,
        });
        const mapContent = await fetchMapContent(result.url, ctx, asset.url);
        return {
          ...asset,
          map_url: result.url,
          map_source: "comment",
          ...(mapContent ? { map_content: mapContent } : {}),
        };
      }
    }
  }

  // ── Strategy 2: HTTP header ──────────────────────────────
  if (ctx.config.map_detection.try_header) {
    const result = inspectHeaders(asset.fetch_headers, asset.url);
    if (result.found && result.url) {
      ctx.logger.info(`Stage 2: found map via HTTP header → ${result.url}`, {
        stage: "stage-2",
        asset_url: asset.url,
      });
      const mapContent = await fetchMapContent(result.url, ctx, asset.url);
      return {
        ...asset,
        map_url: result.url,
        map_source: "header",
        ...(mapContent ? { map_content: mapContent } : {}),
      };
    }
  }

  // ── Strategy 3: Path inference (HEAD requests) ───────────
  const inferResult = await inferMapPath(asset.url, ctx);
  if (inferResult.found && inferResult.url) {
    const mapContent = await fetchMapContent(inferResult.url, ctx, asset.url);
    return {
      ...asset,
      map_url: inferResult.url,
      map_source: "inferred",
      ...(mapContent ? { map_content: mapContent } : {}),
    };
  }

  // ── No map found ─────────────────────────────────────────
  ctx.logger.info(`Stage 2: no source map found — routing to de-obfuscation`, {
    stage: "stage-2",
    asset_url: asset.url,
  });
  return { ...asset, map_url: null, map_source: null };
}

// ----------------------------------------------------------
// INTERNAL: fetch and validate .map file content
// ----------------------------------------------------------

async function fetchMapContent(
  mapUrl: string,
  ctx: PipelineContext,
  assetUrl: string
): Promise<string | null> {
  try {
    const res = await fetchUrl(mapUrl, ctx);
    if (res.status < 200 || res.status >= 300) {
      ctx.logger.warn(`Stage 2: map fetch returned HTTP ${res.status}: ${mapUrl}`, {
        stage: "stage-2",
        asset_url: assetUrl,
      });
      return null;
    }

    // Validate it looks like a source map JSON
    const trimmed = res.body.trimStart();
    if (!trimmed.startsWith("{")) {
      ctx.logger.warn(`Stage 2: map response does not look like JSON: ${mapUrl}`, {
        stage: "stage-2",
        asset_url: assetUrl,
      });
      return null;
    }

    // Parse and validate Source Map v3 spec conformance
    const validation = validateSourceMapJson(res.body);
    if (!validation.valid) {
      ctx.logger.warn(
        `Stage 2: map validation failed for ${mapUrl}: ${validation.reason}`,
        { stage: "stage-2", asset_url: assetUrl }
      );
      // Still return the content for best-effort reconstruction —
      // partial/non-conformant maps can still yield useful data
      if (validation.recoverable) {
        ctx.logger.info(
          `Stage 2: proceeding with non-conformant map (recoverable)`,
          { stage: "stage-2", asset_url: assetUrl }
        );
        return res.body;
      }
      return null;
    }

    return res.body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Stage 2: failed to fetch map ${mapUrl}: ${msg}`, {
      stage: "stage-2",
      asset_url: assetUrl,
    });
    return null;
  }
}

/**
 * Validate that a JSON string conforms to the Source Map v3 specification.
 */
function validateSourceMapJson(
  raw: string
): { valid: boolean; recoverable: boolean; reason?: string } {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    return { valid: false, recoverable: false, reason: "Invalid JSON" };
  }

  // Check version field (must be 3)
  if (json["version"] !== 3) {
    const ver = json["version"];
    // Version missing but has sources → probably still usable
    if (ver === undefined && Array.isArray(json["sources"])) {
      return { valid: false, recoverable: true, reason: "Missing version field (has sources)" };
    }
    return {
      valid: false,
      recoverable: false,
      reason: `Unsupported source map version: ${ver}`,
    };
  }

  // Check for required fields
  if (!json["sources"] && !json["sections"]) {
    return {
      valid: false,
      recoverable: false,
      reason: "Missing both 'sources' and 'sections' fields",
    };
  }

  // Index source maps (sections field) are valid but structured differently
  if (Array.isArray(json["sections"])) {
    return { valid: true, recoverable: true };
  }

  // Standard map: sources should be an array
  if (!Array.isArray(json["sources"])) {
    return {
      valid: false,
      recoverable: false,
      reason: "'sources' is not an array",
    };
  }

  // Mappings field is expected but not strictly required (paths_only reconstruction)
  if (typeof json["mappings"] !== "string") {
    return {
      valid: false,
      recoverable: true,
      reason: "Missing or invalid 'mappings' field (sources available)",
    };
  }

  return { valid: true, recoverable: true };
}
