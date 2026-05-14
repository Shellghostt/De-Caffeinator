// ============================================================
// STAGE 3 — NAME RECOVERY
// Uses the VLQ-decoded mappings and names[] array to replace
// minified single-letter identifiers with their original names.
//
// This significantly improves readability even when
// sourcesContent is absent. The result is the minified JS
// with inline comments or direct substitutions showing
// what each mangled identifier originally was.
// ============================================================

import { MappingSegment, decodeMappings, groupBySource, extractNameReferences } from "./vlq-decoder";
import { ParsedSourceMap } from "./map-parser";

export interface NameRecoveryResult {
  /** The minified JS with recovered names annotated */
  annotatedJs: string;
  /** Count of identifiers recovered */
  recoveredCount: number;
  /** Map of minified name → original name (for downstream use) */
  nameMap: Map<string, string>;
}

/**
 * Attempt to recover original identifier names in minified JS
 * using the mappings + names arrays from the source map.
 *
 * Strategy:
 * 1. Decode VLQ mappings to get positional data
 * 2. For each mapping with a nameIndex, find the minified token at that position
 * 3. Build a substitution map: mangled → original
 * 4. Replace mangled identifiers with original names throughout the source
 */
export function recoverNames(
  minifiedJs: string,
  map: ParsedSourceMap
): NameRecoveryResult {
  if (map.names.length === 0 || !map.mappings) {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap: new Map() };
  }

  // Decode all mappings
  let segments: MappingSegment[];
  try {
    segments = decodeMappings(map.mappings);
  } catch {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap: new Map() };
  }

  // Build the name substitution map from the generated (minified) code positions
  const nameMap = new Map<string, string>();
  const lines = minifiedJs.split("\n");

  for (const seg of segments) {
    if (seg.nameIndex < 0 || seg.nameIndex >= map.names.length) continue;

    const originalName = map.names[seg.nameIndex];
    if (!originalName || originalName.length <= 1) continue;

    // Extract the minified identifier at this generated position
    const genLine = lines[seg.generatedLine];
    if (!genLine) continue;

    const mangledName = extractIdentifierAt(genLine, seg.generatedColumn);
    if (!mangledName) continue;

    // Only record if the name actually changed (was mangled)
    if (mangledName !== originalName && mangledName.length < originalName.length) {
      // Prefer longer original names (more informative)
      const existing = nameMap.get(mangledName);
      if (!existing || originalName.length > existing.length) {
        nameMap.set(mangledName, originalName);
      }
    }
  }

  if (nameMap.size === 0) {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap };
  }

  // Apply substitutions: replace short mangled identifiers with original names
  let annotated = minifiedJs;
  const sortedEntries = [...nameMap.entries()].sort(
    // Replace longer mangled names first to avoid partial matches
    (a, b) => b[0].length - a[0].length
  );

  for (const [mangled, original] of sortedEntries) {
    // Use word-boundary matching to avoid replacing partial identifiers
    // e.g. don't replace 'a' inside 'var' or 'class'
    const escaped = escapeRegExp(mangled);
    const re = new RegExp(`\\b${escaped}\\b`, "g");
    annotated = annotated.replace(re, original);
  }

  // Prepend a recovery report header
  const header = buildRecoveryHeader(nameMap);
  annotated = header + annotated;

  return {
    annotatedJs: annotated,
    recoveredCount: nameMap.size,
    nameMap,
  };
}

/**
 * Build a structured fragment map for a specific source file.
 * Uses VLQ mappings to extract which lines in the minified code
 * correspond to which lines in the original source.
 * Returns an array of line-level mapping info.
 */
export interface LineMapping {
  /** Original source line (0-based) */
  originalLine: number;
  /** Generated (minified) line (0-based) */
  generatedLine: number;
  /** Column range in the generated code */
  generatedColumnStart: number;
  generatedColumnEnd: number;
  /** Original names used at this position */
  names: string[];
}

export function buildLineMappings(
  map: ParsedSourceMap,
  sourceIndex: number
): LineMapping[] {
  let segments: MappingSegment[];
  try {
    segments = decodeMappings(map.mappings);
  } catch {
    return [];
  }

  const sourceSegments = segments.filter((s) => s.sourceIndex === sourceIndex);
  if (sourceSegments.length === 0) return [];

  const result: LineMapping[] = [];

  for (let i = 0; i < sourceSegments.length; i++) {
    const seg = sourceSegments[i];
    const next = sourceSegments[i + 1];

    const names: string[] = [];
    if (seg.nameIndex >= 0 && seg.nameIndex < map.names.length) {
      names.push(map.names[seg.nameIndex]);
    }

    result.push({
      originalLine: seg.originalLine,
      generatedLine: seg.generatedLine,
      generatedColumnStart: seg.generatedColumn,
      generatedColumnEnd: next && next.generatedLine === seg.generatedLine
        ? next.generatedColumn
        : -1, // -1 means "to end of line"
      names,
    });
  }

  return result;
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function extractIdentifierAt(line: string, column: number): string | null {
  if (column >= line.length) return null;

  // An identifier is [a-zA-Z_$][a-zA-Z0-9_$]*
  const remaining = line.slice(column);
  const match = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(remaining);
  return match ? match[0] : null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRecoveryHeader(nameMap: Map<string, string>): string {
  const entries = [...nameMap.entries()]
    .slice(0, 100) // cap header size
    .map(([m, o]) => `${m} → ${o}`)
    .join(", ");

  return [
    "/* [BlobUnpacker] Name Recovery Report:",
    ` *   ${nameMap.size} identifiers recovered via VLQ mapping analysis.`,
    ` *   Substitutions: ${entries}`,
    " */",
    "",
  ].join("\n");
}
