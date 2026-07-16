// ============================================================
// STAGE 3 — NAME RECOVERY
// Uses VLQ-decoded mappings + names[] to annotate minified
// identifiers at their mapped positions (no global replace).
// ============================================================

import { MappingSegment, decodeMappings } from "./vlq-decoder";
import { ParsedSourceMap } from "./map-parser";

export interface NameRecoveryResult {
  annotatedJs: string;
  recoveredCount: number;
  nameMap: Map<string, string>;
}

/**
 * Annotate original names at mapped columns instead of globally
 * substituting identifiers (which corrupts strings/scopes).
 */
export function recoverNames(
  minifiedJs: string,
  map: ParsedSourceMap
): NameRecoveryResult {
  if (map.names.length === 0 || !map.mappings) {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap: new Map() };
  }

  let segments: MappingSegment[];
  try {
    segments = decodeMappings(map.mappings);
  } catch {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap: new Map() };
  }

  const nameMap = new Map<string, string>();
  const lines = minifiedJs.split("\n");

  // Collect annotations per line: column → comment text (descending col for insert)
  const annotationsByLine = new Map<number, Array<{ col: number; note: string }>>();

  for (const seg of segments) {
    if (seg.nameIndex < 0 || seg.nameIndex >= map.names.length) continue;

    const originalName = map.names[seg.nameIndex];
    if (!originalName || originalName.length <= 1) continue;

    const genLine = lines[seg.generatedLine];
    if (!genLine) continue;

    const mangledName = extractIdentifierAt(genLine, seg.generatedColumn);
    if (!mangledName) continue;
    if (mangledName === originalName) continue;

    if (mangledName.length < originalName.length) {
      const existing = nameMap.get(mangledName);
      if (!existing || originalName.length > existing.length) {
        nameMap.set(mangledName, originalName);
      }
    }

    const note = `/*${originalName}*/`;
    let list = annotationsByLine.get(seg.generatedLine);
    if (!list) {
      list = [];
      annotationsByLine.set(seg.generatedLine, list);
    }
    // Insert after the identifier
    const insertCol = seg.generatedColumn + mangledName.length;
    if (!list.some((a) => a.col === insertCol && a.note === note)) {
      list.push({ col: insertCol, note });
    }
  }

  if (nameMap.size === 0 && annotationsByLine.size === 0) {
    return { annotatedJs: minifiedJs, recoveredCount: 0, nameMap };
  }

  const annotatedLines = lines.map((line, lineIdx) => {
    const notes = annotationsByLine.get(lineIdx);
    if (!notes || notes.length === 0) return line;
    notes.sort((a, b) => b.col - a.col);
    let result = line;
    for (const { col, note } of notes) {
      if (col < 0 || col > result.length) continue;
      result = result.slice(0, col) + note + result.slice(col);
    }
    return result;
  });

  const header = buildRecoveryHeader(nameMap);
  return {
    annotatedJs: header + annotatedLines.join("\n"),
    recoveredCount: nameMap.size,
    nameMap,
  };
}

export interface LineMapping {
  originalLine: number;
  generatedLine: number;
  generatedColumnStart: number;
  generatedColumnEnd: number;
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
      generatedColumnEnd:
        next && next.generatedLine === seg.generatedLine ? next.generatedColumn : -1,
      names,
    });
  }

  return result;
}

function extractIdentifierAt(line: string, column: number): string | null {
  if (column >= line.length) return null;
  const remaining = line.slice(column);
  const match = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(remaining);
  return match ? match[0] : null;
}

function buildRecoveryHeader(nameMap: Map<string, string>): string {
  const entries = [...nameMap.entries()]
    .slice(0, 100)
    .map(([m, o]) => `${m} → ${o}`)
    .join(", ");

  return [
    "/* [BlobUnpacker] Name Recovery Report:",
    ` *   ${nameMap.size} identifiers annotated via VLQ mapping analysis.`,
    ` *   Sample: ${entries}`,
    " */",
    "",
  ].join("\n");
}
