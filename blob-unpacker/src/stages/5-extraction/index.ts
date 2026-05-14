// ============================================================
// STAGE 5 — SENSITIVE ARTIFACT EXTRACTION (Enhanced Entry Point)
// Convergence point: receives output from Stage 3 (reconstructed
// source files) and/or Stage 4 (de-obfuscated JS).
//
// Runs BOTH extraction approaches per the spec:
//   1. Regex-based extraction (fast, broad coverage)
//   2. AST-based extraction (precise, deep analysis)
//
// Then deduplicates, classifies, and merges results.
// ============================================================

import {
  ReconstructedSource,
  DeobfuscatedAsset,
  ExtractedArtifacts,
} from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { extractEndpoints } from "./endpoint-extractor";
import { extractSecrets } from "./secret-extractor";
import { extractComments } from "./comment-extractor";
import { extractConfigs } from "./config-extractor";
import { extractViaAst } from "./ast-extractor";

export async function extract(
  reconstructed: ReconstructedSource | null,
  deobfuscated: DeobfuscatedAsset | null,
  ctx: PipelineContext
): Promise<ExtractedArtifacts> {
  const assetUrl = reconstructed?.asset_url ?? deobfuscated?.asset_url ?? "";
  const minEntropy = ctx.config.extraction.min_secret_entropy;

  ctx.logger.info(`Stage 5: extracting artifacts from ${assetUrl}`, {
    stage: "stage-5",
    asset_url: assetUrl,
  });

  // ── Build a list of { code, sourceFile } units to scan ───
  const units: Array<{ code: string; sourceFile: string }> = [];

  // Reconstructed source files (best quality — original code)
  if (reconstructed?.files?.length) {
    for (const file of reconstructed.files) {
      if (file.content && !file.path.startsWith("_")) {
        units.push({ code: file.content, sourceFile: file.path });
      }
    }
  }

  // De-obfuscated JS (whole-file or per-module)
  if (deobfuscated) {
    if (deobfuscated.modules.length > 0) {
      for (const mod of deobfuscated.modules) {
        units.push({ code: mod.content, sourceFile: `${assetUrl}#module-${mod.id}` });
      }
    } else {
      units.push({ code: deobfuscated.readable_js, sourceFile: assetUrl });
    }
  }

  if (units.length === 0) {
    ctx.logger.warn(`Stage 5: no scannable code for ${assetUrl}`, {
      stage: "stage-5",
      asset_url: assetUrl,
    });
    return { asset_url: assetUrl, endpoints: [], secrets: [], comments: [], configs: [] };
  }

  // ── PASS 1: Regex-based extraction (broad coverage) ─────
  const regexEndpoints = units.flatMap((u) => extractEndpoints(u.code, u.sourceFile));
  const regexConfigs = units.flatMap((u) => extractConfigs(u.code, u.sourceFile));

  // ── PASS 2: AST-based extraction (precision) ───────────
  const astEndpoints = [];
  const astConfigs = [];

  for (const unit of units) {
    try {
      const astResult = extractViaAst(unit.code, unit.sourceFile);
      astEndpoints.push(...astResult.endpoints);
      astConfigs.push(...astResult.configs);
    } catch {
      // AST parsing failed for this unit — regex results still available
      ctx.logger.debug(`Stage 5: AST extraction failed for ${unit.sourceFile}`, {
        stage: "stage-5",
        asset_url: assetUrl,
      });
    }
  }

  // ── Merge & deduplicate ─────────────────────────────────
  const endpoints = deduplicateBy(
    [...regexEndpoints, ...astEndpoints],
    (e) => e.value
  );

  const secrets = deduplicateBy(
    units.flatMap((u) => extractSecrets(u.code, u.sourceFile, minEntropy)),
    (s) => s.value
  );

  const comments = deduplicateBy(
    units.flatMap((u) => extractComments(u.code, u.sourceFile)),
    (c) => c.text
  );

  const configs = deduplicateBy(
    [...regexConfigs, ...astConfigs],
    (c) => `${c.key}::${c.value}`
  );

  ctx.logger.info(
    `Stage 5: found — endpoints:${endpoints.length} secrets:${secrets.length} ` +
      `comments:${comments.length} configs:${configs.length}`,
    { stage: "stage-5", asset_url: assetUrl }
  );

  return { asset_url: assetUrl, endpoints, secrets, comments, configs };
}

function deduplicateBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
