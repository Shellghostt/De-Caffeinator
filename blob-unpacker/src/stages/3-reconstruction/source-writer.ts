// ============================================================
// STAGE 3 — SOURCE WRITER (Enhanced)
// Writes recovered source files to disk under output/sources/.
// Also writes a directory index and handles path conflicts.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import { ReconstructedFile } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { getAssetDir } from "../../lib/paths";

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
      // Extra safety: prevent any path traversal in the final resolved path
      const outPath = path.resolve(baseDir, file.path);
      if (!outPath.startsWith(path.resolve(baseDir))) {
        ctx.logger.warn(`Source writer: blocked path traversal attempt: ${file.path}`, {
          stage: "stage-3",
        });
        continue;
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, file.content, "utf-8");
      writtenPaths.push(file.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Source writer: failed to write ${file.path}: ${msg}`, {
        stage: "stage-3",
      });
    }
  }

  // Write a simple file index
  if (writtenPaths.length > 0) {
    try {
      const indexContent = writtenPaths.sort().join("\n") + "\n";
      const indexPath = path.join(baseDir, "_file_index.txt");
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
