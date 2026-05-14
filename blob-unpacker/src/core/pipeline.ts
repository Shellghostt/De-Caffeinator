// ============================================================
// BLOB UNPACKER — PIPELINE ORCHESTRATOR
// Enforces the two critical architectural rules:
//   1. BRANCHING: Stage 3 or 4, with overlap for partial maps
//   2. RECURSION: Stage 4 loops until not packed or depth >= max
// ============================================================

import { PipelineContext } from "./context";
import { AssetQueue } from "./queue";
import {
  AssetRecord,
  AssetWithMapInfo,
  ReconstructedSource,
  DeobfuscatedAsset,
  ExtractedArtifacts,
} from "../types/contracts";
import { writeDeobfuscatedOutput } from "../stages/6-output/deobfuscated-writer";
import { writeOutputs } from "../stages/6-output";

// Stage function type signatures — each stage module will implement these
export type Stage2Fn = (asset: AssetRecord, ctx: PipelineContext) => Promise<AssetWithMapInfo>;
export type Stage3Fn = (asset: AssetWithMapInfo, ctx: PipelineContext) => Promise<ReconstructedSource>;
export type Stage4Fn = (js: string, assetUrl: string, depth: number, ctx: PipelineContext) => Promise<DeobfuscatedAsset>;
export type Stage5Fn = (
  reconstructed: ReconstructedSource | null,
  deobfuscated: DeobfuscatedAsset | null,
  ctx: PipelineContext
) => Promise<ExtractedArtifacts>;

export interface PipelineStages {
  detectMap: Stage2Fn;
  reconstruct: Stage3Fn;
  deobfuscate: Stage4Fn;
  extract: Stage5Fn;
}

// ----------------------------------------------------------
// ORCHESTRATOR CLASS
// ----------------------------------------------------------

export class PipelineOrchestrator {
  private ctx: PipelineContext;
  private queue: AssetQueue;
  private stages: PipelineStages;

  constructor(ctx: PipelineContext, queue: AssetQueue, stages: PipelineStages) {
    this.ctx = ctx;
    this.queue = queue;
    this.stages = stages;
  }

  /**
   * Main run loop.
   * Drains the queue, processing each asset through the full pipeline.
   * Respects concurrency limits via the queue's dequeue logic.
   */
  async run(): Promise<void> {
    this.ctx.logger.info("Pipeline started", { stage: "orchestrator" });

    const inflightPromises = new Set<Promise<void>>();

    while (!this.queue.isDrained || inflightPromises.size > 0) {
      const asset = this.queue.dequeue();

      if (asset) {
        const promise = this.processAsset(asset).finally(() => {
          this.queue.markComplete(asset.url);
          inflightPromises.delete(promise);
        });
        inflightPromises.add(promise);
      } else {
        // Queue is either empty or at concurrency limit — wait for a slot
        if (inflightPromises.size > 0) {
          await Promise.race(inflightPromises);
        }
      }

      // Politeness delay between dequeue attempts
      await sleep(this.ctx.config.http.delay_between_ms);
    }

    this.ctx.logger.info("All assets processed. Queue drained.", { stage: "orchestrator" });

    // ── STAGE 6: Output Preparation ──────────────────────
    await writeOutputs(this.ctx);
  }

  // ----------------------------------------------------------
  // PER-ASSET PROCESSING — full stage chain for a single asset
  // ----------------------------------------------------------

  private async processAsset(asset: AssetRecord): Promise<void> {
    const url = asset.url;
    this.ctx.logger.info(`Processing asset`, { stage: "orchestrator", asset_url: url });
    this.ctx.state.setAssetStatus(url, "detecting_map");

    try {
      // ── STAGE 2: Source Map Detection ────────────────────
      const assetWithMap = await this.stages.detectMap(asset, this.ctx);

      let reconstructed: ReconstructedSource | null = null;
      let deobfuscated: DeobfuscatedAsset | null = null;

      // ── BRANCH DECISION ──────────────────────────────────
      if (assetWithMap.map_url !== null || assetWithMap.map_content !== undefined) {
        // MAP FOUND → Stage 3
        this.ctx.state.setAssetStatus(url, "reconstructing");
        reconstructed = await this.runStage3(assetWithMap);

        // OVERLAP RULE: partial reconstruction → also run Stage 4 on unmapped chunks
        if (
          reconstructed.unmapped_minified_chunks.length > 0 &&
          reconstructed.coverage !== "full"
        ) {
          this.ctx.logger.info(
            `Partial map: routing ${reconstructed.unmapped_minified_chunks.length} unmapped chunk(s) to Stage 4`,
            { stage: "orchestrator", asset_url: url }
          );
          this.ctx.state.setAssetStatus(url, "deobfuscating");

          const chunkJs = reconstructed.unmapped_minified_chunks.join("\n\n");
          deobfuscated = await this.runStage4(chunkJs, url);
        }
      } else {
        // NO MAP → Stage 4
        this.ctx.state.setAssetStatus(url, "deobfuscating");
        deobfuscated = await this.runStage4(asset.raw_content, url);
      }

      // ── STAGE 5: Artifact Extraction (convergence point) ─
      this.ctx.state.setAssetStatus(url, "extracting");
      const artifacts = await this.stages.extract(reconstructed, deobfuscated, this.ctx);

      // Store results
      this.ctx.results.add(artifacts);
      this.ctx.state.markHashProcessed(asset.content_hash);
      this.ctx.state.setAssetStatus(url, "complete");

      // ── STAGE 6 (per-asset): Write de-obfuscated output ─
      if (deobfuscated) {
        writeDeobfuscatedOutput(deobfuscated, this.ctx);
      }

      this.ctx.logger.info(
        `Completed: ${artifacts.endpoints.length} endpoints, ${artifacts.secrets.length} secrets found`,
        { stage: "orchestrator", asset_url: url }
      );
    } catch (err) {
      // ISOLATION BOUNDARY: one bad asset never kills the pipeline
      const message = err instanceof Error ? err.message : String(err);
      this.ctx.logger.error(`Asset failed: ${message}`, {
        stage: "orchestrator",
        asset_url: url,
      });
      this.ctx.state.setAssetStatus(url, "failed", message);
    }
  }

  // ----------------------------------------------------------
  // STAGE 3 RUNNER
  // ----------------------------------------------------------

  private async runStage3(asset: AssetWithMapInfo): Promise<ReconstructedSource> {
    this.ctx.logger.info("Running Stage 3: Source Reconstruction", {
      stage: "stage-3",
      asset_url: asset.url,
      map_source: asset.map_source,
    });
    return await this.stages.reconstruct(asset, this.ctx);
  }

  // ----------------------------------------------------------
  // STAGE 4 RUNNER — with recursive loop
  // ----------------------------------------------------------

  private async runStage4(
    js: string,
    assetUrl: string,
    depth = 0
  ): Promise<DeobfuscatedAsset> {
    const maxDepth = this.ctx.config.deobfuscation.max_depth;

    this.ctx.logger.info(`Running Stage 4: De-obfuscation (depth ${depth})`, {
      stage: "stage-4",
      asset_url: assetUrl,
      depth,
    });

    const result = await this.stages.deobfuscate(js, assetUrl, depth, this.ctx);

    // ── RECURSION RULE ────────────────────────────────────
    if (result.still_packed && depth < maxDepth) {
      this.ctx.logger.info(
        `Asset still packed after pass ${depth}. Re-running Stage 4 (depth ${depth + 1}/${maxDepth})`,
        { stage: "stage-4", asset_url: assetUrl }
      );
      return await this.runStage4(result.readable_js, assetUrl, depth + 1);
    }

    if (result.still_packed && depth >= maxDepth) {
      this.ctx.logger.warn(
        `Max de-obfuscation depth (${maxDepth}) reached for ${assetUrl}. Proceeding with best result.`,
        { stage: "stage-4", asset_url: assetUrl }
      );
    }

    return result;
  }
}

// ----------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
