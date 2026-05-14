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
    files.push({ path: "_manifest.md", content: manifest });
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
  // Group files by directory
  const tree = new Map<string, string[]>();
  for (const f of files) {
    if (f.path.startsWith("_")) continue; // skip meta files
    const parts = f.path.split("/");
    const dir = parts.slice(0, -1).join("/") || "(root)";
    const file = parts[parts.length - 1];
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(file);
  }

  // Count by extension
  const extCounts = new Map<string, number>();
  for (const f of files) {
    if (f.path.startsWith("_")) continue;
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "unknown";
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }

  const lines: string[] = [
    "# Source Reconstruction Manifest",
    "",
    "**Coverage:** Full (all sourcesContent available)",
    `**Total files recovered:** ${files.filter((f) => !f.path.startsWith("_")).length}`,
    `**Source map version:** ${map.version}`,
    map.file ? `**Generated file:** ${map.file}` : "",
    map.sourceRoot ? `**Source root:** ${map.sourceRoot}` : "",
    `**Original identifiers:** ${map.names.length}`,
    "",
    "## File Types",
    "",
    ...[...extCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([ext, count]) => `- **.${ext}**: ${count} file(s)`),
    "",
    "## Directory Tree",
    "",
  ];

  const sortedDirs = [...tree.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [dir, dirFiles] of sortedDirs) {
    lines.push(`### ${dir}/`);
    for (const file of dirFiles.sort()) {
      lines.push(`- ✅ ${file}`);
    }
    lines.push("");
  }

  return lines.filter(Boolean).join("\n");
}
