// ============================================================
// STAGE 3 — FULL RECONSTRUCTOR (Enhanced)
// Path A: sourcesContent is present for all sources.
// Reconstructs the original project directory tree with full
// source code. Filters out bundler-generated internal entries,
// sanitizes paths to prevent traversal, and deduplicates files
// that appear under different path aliases.
// ============================================================

import * as path from "path";
import { ReconstructedFile } from "../../types/contracts";
import { ParsedSourceMap } from "./map-parser";

export function fullReconstruct(map: ParsedSourceMap): ReconstructedFile[] {
  const files: ReconstructedFile[] = [];
  const seenPaths = new Set<string>();

  for (let i = 0; i < map.sources.length; i++) {
    const sourcePath = map.sources[i];
    const content = map.sourcesContent?.[i];

    if (!sourcePath || typeof content !== "string") continue;

    // Skip generated bundler internals
    if (isInternalEntry(sourcePath)) continue;

    // Skip empty content (sometimes sourcesContent has empty strings)
    if (content.trim().length === 0) continue;

    const sanitized = sanitizePath(sourcePath);

    // Deduplicate: same content under different path aliases
    if (seenPaths.has(sanitized)) continue;
    seenPaths.add(sanitized);

    files.push({
      path: sanitized,
      content,
    });
  }

  // Add a project manifest summarizing what was recovered
  if (files.length > 0) {
    const manifest = buildManifest(files, map);
    files.push({ path: "_manifest.json", content: manifest });
  }

  return files;
}

function sanitizePath(p: string): string {
  // Prevent path traversal — strip leading slashes and ..
  let normalized = path.normalize(p);

  // Remove leading ../ sequences
  normalized = normalized.replace(/^(\.\.[/\\])+/, "");

  // Remove leading / or \ 
  normalized = normalized.replace(/^[/\\]+/, "");

  // Remove Windows drive letters (C:\...)
  normalized = normalized.replace(/^[a-zA-Z]:[/\\]/, "");

  return normalized;
}

/**
 * Detect bundler-generated internal entries that are not real source files.
 * These are injected by Webpack, Rollup, Parcel, etc. as bootstrap/runtime code.
 */
function isInternalEntry(p: string): boolean {
  const internals = [
    // Webpack
    /webpack\/bootstrap/i,
    /webpack\/runtime/i,
    /webpack\/startup/i,
    /\(webpack\)/i,
    /webpack-internal:/i,
    /webpack\/hot/i,
    /webpack\/buildin/i,
    /webpack:\/\/\/webpack\//i,

    // Node externals
    /^external\s+"/i,
    /^external ".*"$/i,

    // Cache and generated
    /node_modules\/.cache/i,
    /\.hot-update\./i,

    // Polyfills and shims (usually not interesting)
    /core-js\/modules/i,
    /regenerator-runtime/i,

    // Turbopack internals
    /\[turbopack\]/i,
    /turbopack\/dev/i,

    // Parcel internals
    /parcel\/runtime/i,

    // Vite internals
    /\/@vite\/client/i,
    /vite\/dist\/client/i,
  ];
  return internals.some((re) => re.test(p));
}

/**
 * Build a markdown manifest summarizing the reconstructed project.
 */
function buildManifest(files: ReconstructedFile[], map: ParsedSourceMap): string {
  // Build a nested tree structure
  const tree: any = {};
  for (const f of files) {
    if (f.path.startsWith("_")) continue; // skip meta files
    const parts = f.path.split(/[/\\]/);
    let current = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part]) current[part] = {};
      current = current[part];
    }
    const file = parts[parts.length - 1];
    current[file] = "file";
  }

  // Count by extension
  const fileTypes: Record<string, number> = {};
  for (const f of files) {
    if (f.path.startsWith("_")) continue;
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "unknown";
    fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
  }

  const manifest = {
    coverage: "full",
    total_files_recovered: files.filter((f) => !f.path.startsWith("_")).length,
    source_map_version: map.version,
    generated_file: map.file ?? null,
    source_root: map.sourceRoot ?? null,
    original_identifiers: map.names.length,
    file_types: fileTypes,
    directory_tree: tree,
  };

  return JSON.stringify(manifest, null, 2);
}
