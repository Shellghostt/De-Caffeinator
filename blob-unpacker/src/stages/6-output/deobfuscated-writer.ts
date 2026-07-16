// ============================================================
// STAGE 6 — DEOBFUSCATED FILE WRITER
// ============================================================

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { DeobfuscatedAsset } from "../../types/contracts";
import { PipelineContext } from "../../core/context";
import { getAssetDir } from "../../lib/paths";
import { isPathInside, sanitizeSourcePath } from "../../lib/safe-path";

export function writeDeobfuscatedOutput(
  asset: DeobfuscatedAsset,
  ctx: PipelineContext
): void {
  if (!ctx.config.output.write_source_files) return;

  const assetDir = getAssetDir(asset.asset_url, ctx.config.target_urls, ctx.config.output.dir);
  const deobDir = path.join(assetDir, "deobfuscated");
  fs.mkdirSync(deobDir, { recursive: true });

  if (asset.original_js && asset.original_js !== asset.readable_js) {
    const rawDir = path.join(assetDir, "raw");
    fs.mkdirSync(rawDir, { recursive: true });
    const rawName = sanitizeSourcePath(urlToFilename(asset.asset_url) + ".js");
    const rawPath = path.resolve(rawDir, rawName);
    if (isPathInside(rawDir, rawPath)) {
      try {
        fs.writeFileSync(rawPath, asset.original_js, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Deob writer: failed to write raw ${rawPath}: ${msg}`, {
          stage: "stage-6",
        });
      }
    }
  }

  const safeName = sanitizeSourcePath(urlToFilename(asset.asset_url));
  const fullPath = path.resolve(deobDir, `${safeName}.js`);
  if (!isPathInside(deobDir, fullPath)) {
    ctx.logger.warn(`Deob writer: blocked path outside deobDir for ${asset.asset_url}`, {
      stage: "stage-6",
    });
    return;
  }

  try {
    fs.writeFileSync(fullPath, asset.readable_js, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(`Deob writer: failed to write ${fullPath}: ${msg}`, {
      stage: "stage-6",
    });
    return;
  }

  if (asset.modules.length > 0) {
    const moduleDir = path.join(deobDir, safeName);
    fs.mkdirSync(moduleDir, { recursive: true });

    for (const mod of asset.modules) {
      const modName = sanitizeSourcePath(safeModuleId(mod.id) + ".js");
      const modPath = path.resolve(moduleDir, modName);
      if (!isPathInside(moduleDir, modPath)) continue;
      try {
        const header =
          `// ============================================================\n` +
          `// Module: ${mod.id}\n` +
          `// Source: ${asset.asset_url}\n` +
          `// Techniques: ${asset.techniques_applied.join(", ")}\n` +
          `// ============================================================\n\n`;
        fs.writeFileSync(modPath, header + mod.content, "utf-8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Deob writer: failed module write ${modPath}: ${msg}`, {
          stage: "stage-6",
        });
      }
    }

    const indexContent = asset.modules
      .map((m) => `${safeModuleId(m.id)}.js  ← module "${m.id}"`)
      .join("\n");
    try {
      const indexPath = path.resolve(moduleDir, "_module_index.txt");
      if (isPathInside(moduleDir, indexPath)) {
        fs.writeFileSync(indexPath, indexContent + "\n", "utf-8");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.debug(`Deob writer: module index write failed: ${msg}`, {
        stage: "stage-6",
      });
    }
  }

  ctx.logger.info(
    `Deob writer: wrote ${safeName}.js` +
      (asset.modules.length > 0 ? ` + ${asset.modules.length} module file(s)` : ""),
    { stage: "stage-6", asset_url: asset.asset_url }
  );
}

function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    let name = parsed.pathname
      .replace(/^\//, "")
      .replace(/\//g, "_")
      .replace(/\.js$/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    if (name.length > 80) {
      const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
      name = name.slice(0, 72) + "_" + hash;
    }

    return name || "unnamed";
  } catch {
    const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
    return `inline_${hash}`;
  }
}

function safeModuleId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "").slice(0, 60) || "module";
}
