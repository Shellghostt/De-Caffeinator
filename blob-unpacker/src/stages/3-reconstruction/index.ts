// ============================================================
// STAGE 3 — SOURCE RECONSTRUCTION (Entry Point — Enhanced)
// Branches between full reconstruction (sourcesContent present)
// and partial reconstruction (paths-only or mixed coverage).
// Unmapped chunks are passed back for Stage 4 to handle.
//
// Enhancement over original:
//   - Reports VLQ-based name recovery stats
//   - Handles corrupted/partial maps gracefully
//   - Writes fragment files for partially mapped sources
// ============================================================

import { AssetWithMapInfo, ReconstructedSource } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { parseSourceMap, hasFullContent, hasPartialContent } from "./map-parser";
import { fullReconstruct } from "./full-reconstructor";
import { partialReconstruct } from "./partial-reconstructor";
import { writeSourceFiles } from "./source-writer";

export async function reconstruct(
  asset: AssetWithMapInfo,
  ctx: PipelineContext
): Promise<ReconstructedSource> {
  ctx.logger.info(`Stage 3: reconstructing ${asset.url}`, {
    stage: "stage-3",
    asset_url: asset.url,
    map_source: asset.map_source,
  });

  // map_content must exist at this point — Stage 2 guarantees it
  if (!asset.map_content) {
    ctx.logger.warn(`Stage 3: map_content missing for ${asset.url}, routing to Stage 4`, {
      stage: "stage-3",
      asset_url: asset.url,
    });
    return {
      asset_url: asset.url,
      files: [],
      coverage: "paths_only",
      unmapped_minified_chunks: [asset.raw_content],
    };
  }

  // ── Parse source map ─────────────────────────────────────
  let map;
  try {
    map = parseSourceMap(asset.map_content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Stage 3: map parse failed (${msg}), routing to Stage 4`, {
      stage: "stage-3",
      asset_url: asset.url,
    });
    return {
      asset_url: asset.url,
      files: [],
      coverage: "paths_only",
      unmapped_minified_chunks: [asset.raw_content],
    };
  }

  const contentStatus = map.sourcesContent
    ? `present (${map.sourcesContent.filter((c) => c !== null).length}/${map.sources.length} with content)`
    : "absent";

  ctx.logger.info(
    `Stage 3: map has ${map.sources.length} source(s), ${map.names.length} name(s), ` +
      `sourcesContent: ${contentStatus}`,
    { stage: "stage-3", asset_url: asset.url }
  );

  // ── Branch A: Full reconstruction ────────────────────────
  if (hasFullContent(map)) {
    const files = fullReconstruct(map);
    writeSourceFiles(files, asset.content_hash, ctx, asset.url);

    ctx.logger.info(`Stage 3: full reconstruction — ${files.length} file(s) recovered`, {
      stage: "stage-3",
      asset_url: asset.url,
    });

    return {
      asset_url: asset.url,
      files,
      coverage: "full",
      unmapped_minified_chunks: [], // nothing left for Stage 4
    };
  }

  // ── Branch B: Partial or paths-only reconstruction ───────
  const { recoveredFiles, unmappedChunks, knownPaths } = partialReconstruct(
    map,
    asset.raw_content
  );

  if (recoveredFiles.length > 0) {
    writeSourceFiles(recoveredFiles, asset.content_hash, ctx, asset.url);
  }

  const coverage = hasPartialContent(map) ? "partial" : "paths_only";

  // Count fragment files and placeholder files for logging
  const fragmentCount = recoveredFiles.filter((f) => f.path.endsWith(".fragments.js")).length;
  const placeholderCount = knownPaths.filter((p) => {
    const hasContent = map.sourcesContent?.[map.sources.indexOf(p)];
    return !hasContent;
  }).length;

  ctx.logger.info(
    `Stage 3: ${coverage} reconstruction — ` +
      `${recoveredFiles.length} file(s) written, ` +
      `${knownPaths.length} path(s) known, ` +
      `${fragmentCount} fragment file(s), ` +
      `${placeholderCount} placeholder(s), ` +
      `${unmappedChunks.length} chunk(s) → Stage 4`,
    { stage: "stage-3", asset_url: asset.url }
  );

  return {
    asset_url: asset.url,
    files: recoveredFiles,
    coverage,
    unmapped_minified_chunks: unmappedChunks,
  };
}
