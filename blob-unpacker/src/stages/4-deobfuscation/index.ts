// ============================================================
// STAGE 4 — DE-OBFUSCATION (WEBCRACK-POWERED)
//
// Uses webcrack as the sole de-obfuscation engine.
// All custom Babel transforms have been removed.
//
// webcrack handles:
//   - String array rotation/decryption
//   - Proxy function inlining
//   - Control flow unflattening
//   - Dead code elimination
//   - Constant folding
//   - Webpack/Browserify bundle unpacking
//   - General de-minification
//
// Processing order:
//   1. Eval/packer unwrapping (pre-process for webcrack)
//   2. webcrack core (deobfuscate + unminify + unpack)
//   3. Beautification (final formatting)
// ============================================================

import { DeobfuscatedAsset, DeobfuscationTechnique, WebpackModule } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { beautifyJs } from "./beautifier";
import { evalUnpack, isStillPacked } from "./eval-unpacker";

export async function deobfuscate(
  js: string,
  assetUrl: string,
  depth: number,
  ctx: PipelineContext
): Promise<DeobfuscatedAsset> {
  ctx.logger.info(`Stage 4: de-obfuscation pass (depth ${depth}) for ${assetUrl}`, {
    stage: "stage-4",
    asset_url: assetUrl,
    depth,
  });

  let code = js;
  const techniques: DeobfuscationTechnique[] = [];
  const modules: WebpackModule[] = [];

  // ── Step 1: Eval/packer unwrapping (must be first) ───────
  // webcrack can't handle outer eval wrappers, so we pre-process
  const evalResult = evalUnpack(code);
  if (evalResult.unpacked) {
    code = evalResult.code;
    techniques.push("eval_unpack");
    ctx.logger.info(`Stage 4: eval unpacked (pre-webcrack)`, {
      stage: "stage-4",
      asset_url: assetUrl,
    });
  }

  // ── Step 2: webcrack core ────────────────────────────────
  try {
    // Dynamic import — webcrack is ESM-only
    const { webcrack } = await import("webcrack");

    ctx.logger.info(`Stage 4: running webcrack...`, {
      stage: "stage-4",
      asset_url: assetUrl,
    });

    const result = await webcrack(code, {
      deobfuscate: true,
      unminify: true,
      unpack: true,
    });

    techniques.push("webcrack");

    // ── Handle bundle output ──────────────────────────────
    if (result.bundle) {
      const bundleType = result.bundle.type || "webpack";
      ctx.logger.info(
        `Stage 4: webcrack detected ${bundleType} bundle`,
        { stage: "stage-4", asset_url: assetUrl }
      );

      // Iterate over all extracted modules
      for (const [id, module] of Array.from(result.bundle.modules)) {
        if (module.code && module.code.trim().length > 0) {
          modules.push({
            id: String(id),
            content: module.code,
          });
        }
      }

      if (modules.length > 0) {
        techniques.push("webpack_split");
        ctx.logger.info(
          `Stage 4: webcrack split → ${modules.length} module(s)`,
          { stage: "stage-4", asset_url: assetUrl }
        );

        // Build the readable output from all modules
        code = modules
          .map((m) => `/* ── module: ${m.id} ── */\n${m.content}`)
          .join("\n\n");
      }
    }

    // ── Handle deobfuscated code ──────────────────────────
    if (result.code && modules.length === 0) {
      code = result.code;
    }

    ctx.logger.info(`Stage 4: webcrack pass complete`, {
      stage: "stage-4",
      asset_url: assetUrl,
    });
  } catch (webcrackErr) {
    // ── FALLBACK: webcrack failed ──────────────────────────
    // Log the error and proceed with whatever we have.
    // Stage 5 can still do regex extraction on raw code.
    const errMsg = webcrackErr instanceof Error ? webcrackErr.message : String(webcrackErr);
    ctx.logger.warn(
      `Stage 4: webcrack failed, proceeding with raw code: ${errMsg}`,
      { stage: "stage-4", asset_url: assetUrl, error: errMsg }
    );
  }

  // ── Step 3: Beautify (final formatting) ──────────────────
  const beautified = beautifyJs(code);
  if (beautified !== code) {
    code = beautified;
    techniques.push("beautify");
  }

  // ── Check if still packed ─────────────────────────────────
  const stillPacked = isStillPacked(code);
  if (stillPacked) {
    ctx.logger.info(`Stage 4: still packed after pass ${depth}`, {
      stage: "stage-4",
      asset_url: assetUrl,
    });
  }

  ctx.logger.info(
    `Stage 4: pass ${depth} complete — techniques: [${techniques.join(", ")}]`,
    { stage: "stage-4", asset_url: assetUrl }
  );

  return {
    asset_url: assetUrl,
    readable_js: code,
    original_js: js,
    modules,
    techniques_applied: techniques,
    depth,
    still_packed: stillPacked,
  };
}
