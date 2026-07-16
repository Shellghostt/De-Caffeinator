// ============================================================
// STAGE 3 — SOURCE WRITER (Enhanced)
// Writes recovered source files to disk under output/sources/.
// Also writes a directory index, raw .map files, and handles
// path conflicts.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { ReconstructedFile } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { getAssetDir } from "../../lib/paths";
import { isPathInside, sanitizeSourcePath } from "../../lib/safe-path";

export function writeSourceFiles(
  files: ReconstructedFile[],
  assetHash: string,
  ctx: PipelineContext,
  assetUrl?: string
): void {
  if (!ctx.config.output.write_source_files || files.length === 0) return;

  // Resolve output dir: first-party vs third-party nesting
  const assetDir = assetUrl
    ? getAssetDir(assetUrl, ctx.config.target_urls, ctx.config.output.dir)
    : ctx.config.output.dir;
  const baseDir = path.join(assetDir, "sources", assetHash);
  const writtenPaths: string[] = [];

  for (const file of files) {
    try {
      const safeRel = sanitizeSourcePath(file.path);
      const outPath = path.resolve(baseDir, safeRel);
      if (!isPathInside(baseDir, outPath)) {
        ctx.logger.warn(`Source writer: blocked path traversal attempt: ${file.path}`, {
          stage: "stage-3",
        });
        continue;
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, file.content, "utf-8");
      writtenPaths.push(safeRel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Source writer: failed to write ${file.path}: ${msg}`, {
        stage: "stage-3",
      });
    }
  }

  // Write a JSON file index
  if (writtenPaths.length > 0) {
    try {
      const indexContent = JSON.stringify(writtenPaths.sort(), null, 2);
      const indexPath = path.join(baseDir, "_file_index.json");
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, indexContent, "utf-8");
    } catch {
      // Non-critical — skip silently
    }
  }

  ctx.logger.info(`Source writer: wrote ${writtenPaths.length} file(s) to sources/${assetHash}`, {
    stage: "stage-3",
  });
}

/**
 * Write the raw .map file to disk alongside the reconstructed sources.
 * Persists the source map JSON so it's available for external tooling.
 */
export function writeMapFile(
  mapContent: string,
  assetHash: string,
  ctx: PipelineContext,
  assetUrl?: string
): void {
  if (!ctx.config.output.write_source_files) return;

  const assetDir = assetUrl
    ? getAssetDir(assetUrl, ctx.config.target_urls, ctx.config.output.dir)
    : ctx.config.output.dir;
  const baseDir = path.join(assetDir, "sources", assetHash);

  try {
    const mapPath = path.join(baseDir, "_sourcemap.map");
    if (!isPathInside(baseDir, mapPath)) {
      ctx.logger.warn(`Source writer: refused to write .map outside base dir`, {
        stage: "stage-3",
      });
      return;
    }
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, mapContent, "utf-8");
    ctx.logger.info(`Source writer: saved raw .map file to sources/${assetHash}/_sourcemap.map`, {
      stage: "stage-3",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Source writer: failed to write .map file: ${msg}`, {
      stage: "stage-3",
    });
  }
}
