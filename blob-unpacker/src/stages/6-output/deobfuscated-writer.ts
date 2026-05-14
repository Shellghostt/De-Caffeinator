// ============================================================
// STAGE 6 — DEOBFUSCATED FILE WRITER
// Writes de-obfuscated JavaScript output to disk.
// Each asset gets a file in output/deobfuscated/.
// Webpack-split modules get individual files in a subdirectory.
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { DeobfuscatedAsset } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { getHostDir } from "../../lib/paths";

export function writeDeobfuscatedOutput(
  asset: DeobfuscatedAsset,
  ctx: PipelineContext
): void {
  if (!ctx.config.output.write_source_files) return;

  // ── Per-hostname subdirectory ───────────────────────────
  const hostDir = getHostDir(asset.asset_url, ctx.config.output.dir);
  const deobDir = path.join(hostDir, "deobfuscated");
  fs.mkdirSync(deobDir, { recursive: true });

  // ── Also save the raw original JS ──────────────────────
  // (only if it differs from the deobfuscated version)
  if (asset.original_js && asset.original_js !== asset.readable_js) {
    const rawDir = path.join(hostDir, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const rawPath = path.join(rawDir, `${urlToFilename(asset.asset_url)}.js`);
    try {
      fs.writeFileSync(rawPath, asset.original_js, "utf-8");
    } catch {
      // Non-critical
    }
  }

  // Generate a safe filename from the asset URL
  const safeName = urlToFilename(asset.asset_url);

  // Write the full readable JS
  const fullPath = path.join(deobDir, `${safeName}.js`);
  try {
    fs.writeFileSync(fullPath, asset.readable_js, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Deob writer: failed to write ${fullPath}: ${msg}`, {
      stage: "stage-6",
    });
    return;
  }

  // If modules were split, write each one individually
  if (asset.modules.length > 0) {
    const moduleDir = path.join(deobDir, safeName);
    fs.mkdirSync(moduleDir, { recursive: true });

    for (const mod of asset.modules) {
      const modName = safeModuleId(mod.id);
      const modPath = path.join(moduleDir, `${modName}.js`);
      try {
        // Add a module header comment
        const header = `// ============================================================\n` +
          `// Module: ${mod.id}\n` +
          `// Source: ${asset.asset_url}\n` +
          `// Techniques: ${asset.techniques_applied.join(", ")}\n` +
          `// ============================================================\n\n`;
        fs.writeFileSync(modPath, header + mod.content, "utf-8");
      } catch {
        // Skip failed individual module writes
      }
    }

    // Write module index
    const indexContent = asset.modules
      .map((m) => `${safeModuleId(m.id)}.js  ← module "${m.id}"`)
      .join("\n");
    try {
      fs.writeFileSync(
        path.join(moduleDir, "_module_index.txt"),
        indexContent + "\n",
        "utf-8"
      );
    } catch {
      // Non-critical
    }
  }

  ctx.logger.info(
    `Deob writer: wrote ${safeName}.js` +
      (asset.modules.length > 0 ? ` + ${asset.modules.length} module file(s)` : ""),
    { stage: "stage-6", asset_url: asset.asset_url }
  );
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function urlToFilename(url: string): string {
  // Extract the meaningful part of the URL
  try {
    const parsed = new URL(url);
    let name = parsed.pathname
      .replace(/^\//, "")
      .replace(/\//g, "_")
      .replace(/\.js$/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    // Truncate and add a short hash for uniqueness
    if (name.length > 80) {
      const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
      name = name.slice(0, 72) + "_" + hash;
    }

    return name || "unnamed";
  } catch {
    // Fallback for non-URL identifiers (e.g., inline scripts)
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
    return `inline_${hash}`;
  }
}

function safeModuleId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 60) || "module";
}
