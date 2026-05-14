// ============================================================
// STAGE 3 — PARTIAL RECONSTRUCTOR (Enhanced)
// Path B: sourcesContent is absent or incomplete.
//
// Now uses the VLQ decoder + name recovery to:
//   1. Recover files that DO have content (mixed coverage)
//   2. Create placeholder files for paths we know but can't recover
//   3. Use VLQ mappings to extract code fragments per source file
//   4. Apply name recovery to restore original identifiers
//   5. Annotate minified JS with original names for Stage 4
// ============================================================

import { ReconstructedFile } from "../../types/contracts";
import { ParsedSourceMap } from "./map-parser";
import { recoverNames, buildLineMappings } from "./name-recovery";
import { decodeMappings, groupBySource } from "./vlq-decoder";

export interface PartialReconstructResult {
  /** Files where content was available (mixed coverage case) */
  recoveredFiles: ReconstructedFile[];
  /** Minified chunks that had NO content — must go to Stage 4 */
  unmappedChunks: string[];
  /** File paths we know exist but couldn't recover content for */
  knownPaths: string[];
}

export function partialReconstruct(
  map: ParsedSourceMap,
  rawMinifiedJs: string
): PartialReconstructResult {
  const recoveredFiles: ReconstructedFile[] = [];
  const knownPaths: string[] = [];
  const unrecoverablePaths: string[] = [];

  // ── Phase 1: Recover files that have sourcesContent ──────
  if (map.sourcesContent) {
    for (let i = 0; i < map.sources.length; i++) {
      const filePath = map.sources[i];
      const content = map.sourcesContent[i];

      if (!filePath) continue;
      knownPaths.push(filePath);

      if (typeof content === "string" && content.length > 0) {
        recoveredFiles.push({ path: filePath, content });
      } else {
        unrecoverablePaths.push(filePath);
      }
    }
  } else {
    // Only paths — no content at all
    for (const p of map.sources) {
      if (p) {
        knownPaths.push(p);
        unrecoverablePaths.push(p);
      }
    }
  }

  // ── Phase 2: Create placeholder files for unrecoverable paths ──
  for (const filePath of unrecoverablePaths) {
    const placeholder = buildPlaceholder(filePath, map);
    recoveredFiles.push({ path: filePath, content: placeholder });
  }

  // ── Phase 3: Extract code fragments using VLQ mappings ───
  const fragmentFiles = extractFragmentsViaMappings(map, rawMinifiedJs, unrecoverablePaths);
  for (const ff of fragmentFiles) {
    // Find and update the placeholder with extracted fragments
    const existing = recoveredFiles.find((f) => f.path === ff.path);
    if (existing) {
      existing.content += "\n\n" + ff.content;
    } else {
      recoveredFiles.push(ff);
    }
  }

  // ── Phase 4: Apply name recovery to the minified JS ──────
  const { annotatedJs, recoveredCount, nameMap } = recoverNames(rawMinifiedJs, map);

  // Build the unmapped chunk with name recovery applied
  const unmappedChunks = [annotatedJs];

  // ── Phase 5: Write a project structure manifest ──────────
  if (knownPaths.length > 0) {
    const manifest = buildStructureManifest(knownPaths, recoveredFiles, recoveredCount);
    recoveredFiles.push({
      path: "_project_structure.md",
      content: manifest,
    });
  }

  return { recoveredFiles, unmappedChunks, knownPaths };
}

// ----------------------------------------------------------
// FRAGMENT EXTRACTION VIA VLQ MAPPINGS
// ----------------------------------------------------------

function extractFragmentsViaMappings(
  map: ParsedSourceMap,
  minifiedJs: string,
  targetPaths: string[]
): ReconstructedFile[] {
  if (targetPaths.length === 0 || !map.mappings) return [];

  let segments;
  try {
    segments = decodeMappings(map.mappings);
  } catch {
    return [];
  }

  const bySource = groupBySource(segments);
  const minifiedLines = minifiedJs.split("\n");
  const results: ReconstructedFile[] = [];

  for (const targetPath of targetPaths) {
    const sourceIdx = map.sources.indexOf(targetPath);
    if (sourceIdx < 0) continue;

    const sourceSegments = bySource.get(sourceIdx);
    if (!sourceSegments || sourceSegments.length === 0) continue;

    // Extract code fragments from the minified JS at each mapped position
    const fragments: Array<{ origLine: number; code: string; names: string[] }> = [];

    for (let i = 0; i < sourceSegments.length; i++) {
      const seg = sourceSegments[i];
      const line = minifiedLines[seg.generatedLine];
      if (!line) continue;

      // Find the end of this segment (start of next segment on same line, or end of line)
      const next = sourceSegments[i + 1];
      const endCol = (next && next.generatedLine === seg.generatedLine)
        ? next.generatedColumn
        : line.length;

      const code = line.slice(seg.generatedColumn, endCol).trim();
      if (!code) continue;

      const names: string[] = [];
      if (seg.nameIndex >= 0 && seg.nameIndex < map.names.length) {
        names.push(map.names[seg.nameIndex]);
      }

      fragments.push({ origLine: seg.originalLine, code, names });
    }

    if (fragments.length === 0) continue;

    // Sort by original line number and deduplicate
    fragments.sort((a, b) => a.origLine - b.origLine);

    // Build a reconstructed approximation grouped by original line
    const lineGroups = new Map<number, { codes: string[]; names: string[] }>();
    for (const f of fragments) {
      let group = lineGroups.get(f.origLine);
      if (!group) {
        group = { codes: [], names: [] };
        lineGroups.set(f.origLine, group);
      }
      group.codes.push(f.code);
      group.names.push(...f.names);
    }

    const lines: string[] = [
      `// ──── Reconstructed fragments for: ${targetPath} ────`,
      `// ${lineGroups.size} original line(s) mapped from minified source`,
      `// Names recovered: ${[...new Set(fragments.flatMap((f) => f.names))].join(", ") || "none"}`,
      "",
    ];

    for (const [lineNum, group] of lineGroups) {
      const nameComment = group.names.length > 0
        ? ` // names: ${[...new Set(group.names)].join(", ")}`
        : "";
      lines.push(`/* L${lineNum + 1} */ ${group.codes.join(" ")}${nameComment}`);
    }

    results.push({
      path: targetPath + ".fragments.js",
      content: lines.join("\n"),
    });
  }

  return results;
}

// ----------------------------------------------------------
// PLACEHOLDER BUILDER
// ----------------------------------------------------------

function buildPlaceholder(filePath: string, map: ParsedSourceMap): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const lang = detectLanguage(ext);

  const lines: string[] = [
    `${commentStart(lang)} ============================================================`,
    `${commentStart(lang)} FILE: ${filePath}`,
    `${commentStart(lang)} STATUS: Content could not be recovered from the source map.`,
    `${commentStart(lang)}`,
    `${commentStart(lang)} This file's path was found in the source map's 'sources' array,`,
    `${commentStart(lang)} confirming it exists in the original project. However, the`,
    `${commentStart(lang)} 'sourcesContent' entry for this file was null or missing.`,
    `${commentStart(lang)}`,
    `${commentStart(lang)} The file path reveals:`,
    `${commentStart(lang)}   - Directory structure: ${filePath.split("/").slice(0, -1).join("/") || "(root)"}`,
    `${commentStart(lang)}   - File name: ${filePath.split("/").pop() || filePath}`,
    `${commentStart(lang)}   - Language: ${lang}`,
  ];

  // Add context from names array if we can find relevant identifiers
  const relevantNames = findNamesForSource(filePath, map);
  if (relevantNames.length > 0) {
    lines.push(`${commentStart(lang)}`);
    lines.push(`${commentStart(lang)} Identifiers referenced in this file (from names[]):`);
    lines.push(`${commentStart(lang)}   ${relevantNames.join(", ")}`);
  }

  lines.push(`${commentStart(lang)} ============================================================`);
  lines.push("");

  return lines.join("\n");
}

function findNamesForSource(filePath: string, map: ParsedSourceMap): string[] {
  const sourceIdx = map.sources.indexOf(filePath);
  if (sourceIdx < 0 || !map.mappings) return [];

  try {
    const segments = decodeMappings(map.mappings);
    const names = new Set<string>();

    for (const seg of segments) {
      if (seg.sourceIndex === sourceIdx && seg.nameIndex >= 0 && seg.nameIndex < map.names.length) {
        names.add(map.names[seg.nameIndex]);
      }
    }

    return [...names].slice(0, 50); // Cap at 50 names
  } catch {
    return [];
  }
}

// ----------------------------------------------------------
// PROJECT STRUCTURE MANIFEST
// ----------------------------------------------------------

function buildStructureManifest(
  knownPaths: string[],
  recoveredFiles: ReconstructedFile[],
  recoveredNameCount: number
): string {
  const recoveredPaths = new Set(recoveredFiles.map((f) => f.path));

  // Build a tree visualization
  const tree = new Map<string, string[]>();
  for (const p of knownPaths) {
    const parts = p.split("/");
    const dir = parts.slice(0, -1).join("/") || "(root)";
    const file = parts[parts.length - 1];
    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(file);
  }

  const lines: string[] = [
    "# Project Structure (recovered from source map)",
    "",
    `**Total source files:** ${knownPaths.length}`,
    `**Files with content:** ${recoveredFiles.filter((f) => !f.path.endsWith(".fragments.js") && !f.path.startsWith("_")).length}`,
    `**Identifiers recovered:** ${recoveredNameCount}`,
    "",
    "## Directory Tree",
    "",
  ];

  const sortedDirs = [...tree.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [dir, files] of sortedDirs) {
    lines.push(`### ${dir}/`);
    for (const file of files.sort()) {
      const fullPath = dir === "(root)" ? file : `${dir}/${file}`;
      const status = recoveredPaths.has(fullPath) ? "✅" : "❌";
      lines.push(`- ${status} ${file}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ----------------------------------------------------------
// LANGUAGE HELPERS
// ----------------------------------------------------------

function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript/JSX", js: "JavaScript", jsx: "JavaScript/JSX",
    vue: "Vue", svelte: "Svelte", css: "CSS", scss: "SCSS", less: "LESS",
    html: "HTML", json: "JSON", md: "Markdown", py: "Python", rb: "Ruby",
  };
  return map[ext] || "Unknown";
}

function commentStart(lang: string): string {
  if (["CSS", "SCSS", "LESS"].includes(lang)) return " *";
  return "//";
}
