// ============================================================
// STAGE 4 — DE-OBFUSCATION (Entry Point — Enhanced)
// Applies all techniques in optimal order. The orchestrator
// handles the recursive loop — this stage runs one full pass
// and sets still_packed so the orchestrator knows whether to loop.
//
// Technique order (designed for maximum effectiveness):
//   1. Eval/packer unwrapping (extract payload from wrappers)
//   2. Hex function call resolution (decode _0xabc('0x1f'))
//   3. String array resolution (resolve rotated string arrays)
//   4. Unicode/hex string decoding (AST-based escape resolution)
//   5. Constant folding (fold "a"+"b", String.fromCharCode, etc.)
//   6. Dead code elimination (remove if(false), unreachable code)
//   7. Control flow unflattening (reverse switch-case state machines)
//   8. Bundle splitting (Webpack/Rollup/Vite/Turbopack/Parcel)
//   9. Beautification (final formatting pass)
// ============================================================

import { DeobfuscatedAsset, DeobfuscationTechnique } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { beautifyJs } from "./beautifier";
import { splitBundle } from "./bundle-splitter";
import { evalUnpack, isStillPacked } from "./eval-unpacker";
import { resolveStringArray } from "./string-array-resolver";
import { resolveHexCalls } from "./hex-call-resolver";
import { foldConstants } from "./constant-folder";
import { decodeUnicode } from "./unicode-decoder";
import { eliminateDeadCode } from "./dead-code-eliminator";
import { unflattenControlFlow } from "./control-flow-unflattener";
import { resolveIIFEAliases } from "./iife-alias-resolver";
import { detectLibraries } from "./library-detector";
import { contextRename } from "./context-renamer";

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
  const modules = [];

  // ── Step 1: Eval/packer unwrapping (must be first) ───────
  const evalResult = evalUnpack(code);
  if (evalResult.unpacked) {
    code = evalResult.code;
    techniques.push("eval_unpack");
    ctx.logger.info(`Stage 4: eval unpacked`, { stage: "stage-4", asset_url: assetUrl });
  }

  // ── Step 2: Hex function call resolution ─────────────────
  const hexResult = resolveHexCalls(code);
  if (hexResult.resolved) {
    code = hexResult.code;
    techniques.push("hex_call_resolve");
    ctx.logger.info(
      `Stage 4: resolved ${hexResult.substitutionCount} hex function call(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 3: String array resolution ──────────────────────
  const strResult = resolveStringArray(code);
  if (strResult.resolved) {
    code = strResult.code;
    techniques.push("string_array_resolve");
    ctx.logger.info(
      `Stage 4: resolved ${strResult.substitutionCount} string array reference(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 4: Unicode/hex string decoding (AST-based) ──────
  const unicodeResult = decodeUnicode(code);
  if (unicodeResult.decoded) {
    code = unicodeResult.code;
    techniques.push("unicode_decode");
    ctx.logger.info(
      `Stage 4: decoded ${unicodeResult.decodedCount} unicode/hex string(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 5: Constant folding ──────────────────────────────
  const folded = foldConstants(code);
  if (folded !== code) {
    code = folded;
    techniques.push("constant_fold");
    ctx.logger.info(`Stage 4: constants folded`, { stage: "stage-4", asset_url: assetUrl });
  }

  // ── Step 5b: IIFE parameter alias resolution ─────────────
  // (function(N, d, p) { ... })(window, document, location)
  // → replaces N→window, d→document, p→location throughout body
  const iifeResult = resolveIIFEAliases(code);
  if (iifeResult.resolved) {
    code = iifeResult.code;
    techniques.push("iife_alias_resolve");
    ctx.logger.info(
      `Stage 4: resolved ${iifeResult.aliasCount} IIFE parameter alias(es)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 5c: Context-based variable renaming ─────────────
  // n.createElement("div") → document.createElement("div")
  // Uses heuristic analysis of property/method usage patterns
  const ctxResult = contextRename(code);
  if (ctxResult.renamed) {
    code = ctxResult.code;
    techniques.push("context_rename");
    ctx.logger.info(
      `Stage 4: context-renamed ${ctxResult.renameCount} minified variable(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 6: Dead code elimination ────────────────────────
  const deadResult = eliminateDeadCode(code);
  if (deadResult.eliminated) {
    code = deadResult.code;
    techniques.push("dead_code_eliminate");
    ctx.logger.info(
      `Stage 4: eliminated ${deadResult.removedCount} dead code node(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 7: Control flow unflattening ────────────────────
  const cfResult = unflattenControlFlow(code);
  if (cfResult.unflattened) {
    code = cfResult.code;
    techniques.push("control_flow_unflatten");
    ctx.logger.info(
      `Stage 4: unflattened ${cfResult.patternsFound} control flow pattern(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 8: Bundle splitting (Webpack/Rollup/etc.) ───────
  const bundleResult = splitBundle(code);
  if (bundleResult.isBundled && bundleResult.modules.length > 0) {
    modules.push(...bundleResult.modules);
    techniques.push("webpack_split");
    ctx.logger.info(
      `Stage 4: ${bundleResult.bundler} split → ${bundleResult.modules.length} module(s)`,
      { stage: "stage-4", asset_url: assetUrl }
    );
    // Use joined modules as the readable output
    code = bundleResult.modules
      .map((m) => `/* ── module: ${m.id} ── */\n${m.content}`)
      .join("\n\n");
  }

  // ── Step 8b: Known library detection ─────────────────────
  // Fingerprints jQuery, React, easyXDM, etc. and adds a
  // banner comment identifying them in the output.
  const libResult = detectLibraries(code);
  if (libResult.detected) {
    code = libResult.code;
    techniques.push("library_detect");
    const libNames = libResult.libraries.map((l) => {
      const ver = l.version ? ` v${l.version}` : "";
      return `${l.name}${ver}`;
    });
    ctx.logger.info(
      `Stage 4: detected libraries: [${libNames.join(", ")}]`,
      { stage: "stage-4", asset_url: assetUrl }
    );
  }

  // ── Step 9: Beautify (final formatting) ──────────────────
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
