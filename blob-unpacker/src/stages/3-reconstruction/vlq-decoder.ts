// ============================================================
// STAGE 3 — VLQ DECODER
// Decodes the Base64 VLQ-encoded 'mappings' string from a
// Source Map v3 file into structured position mappings.
//
// Each mapping segment tells you:
//   - generated column (in minified file)
//   - source file index (into sources[])
//   - original line (in original file)
//   - original column (in original file)
//   - name index (into names[], optional)
//
// This is used for partial reconstruction when sourcesContent
// is missing — we can still map minified positions back to
// original positions and recover identifier names.
// ============================================================

// Base64 VLQ alphabet
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Map<string, number>();
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP.set(B64_CHARS[i], i);
}

const VLQ_CONTINUATION_BIT = 0x20; // 6th bit
const VLQ_VALUE_MASK = 0x1f;       // lower 5 bits

export interface MappingSegment {
  /** 0-based line in generated (minified) file */
  generatedLine: number;
  /** 0-based column in generated file */
  generatedColumn: number;
  /** Index into sources[] */
  sourceIndex: number;
  /** 0-based line in original source file */
  originalLine: number;
  /** 0-based column in original source file */
  originalColumn: number;
  /** Index into names[] (may be -1 if no name) */
  nameIndex: number;
}

/**
 * Decode the full 'mappings' string into an array of MappingSegments.
 * Groups are separated by ';' (one per generated line).
 * Segments within a group are separated by ','.
 */
export function decodeMappings(mappings: string): MappingSegment[] {
  const result: MappingSegment[] = [];

  if (!mappings || mappings.length === 0) return result;

  // Accumulated state (all values are relative/delta-encoded)
  let generatedLine = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  const groups = mappings.split(";");

  for (const group of groups) {
    // Reset generated column per line (it's delta within the line)
    generatedColumn = 0;

    if (group.length === 0) {
      generatedLine++;
      continue;
    }

    const segments = group.split(",");

    for (const segment of segments) {
      if (segment.length === 0) continue;

      const decoded = decodeVLQSegment(segment);
      if (decoded.length === 0) continue;

      // Field 1: generated column (always present)
      generatedColumn += decoded[0];

      const mapping: MappingSegment = {
        generatedLine,
        generatedColumn,
        sourceIndex: -1,
        originalLine: -1,
        originalColumn: -1,
        nameIndex: -1,
      };

      if (decoded.length >= 4) {
        // Fields 2-4: source index, original line, original column
        sourceIndex += decoded[1];
        originalLine += decoded[2];
        originalColumn += decoded[3];

        mapping.sourceIndex = sourceIndex;
        mapping.originalLine = originalLine;
        mapping.originalColumn = originalColumn;
      }

      if (decoded.length >= 5) {
        // Field 5: name index
        nameIndex += decoded[4];
        mapping.nameIndex = nameIndex;
      }

      result.push(mapping);
    }

    generatedLine++;
  }

  return result;
}

/**
 * Decode a single VLQ segment (comma-separated part) into an array of values.
 */
function decodeVLQSegment(segment: string): number[] {
  const values: number[] = [];
  let i = 0;

  while (i < segment.length) {
    let value = 0;
    let shift = 0;
    let continuation = true;

    while (continuation && i < segment.length) {
      const char = segment[i++];
      const digit = B64_LOOKUP.get(char);
      if (digit === undefined) break;

      continuation = (digit & VLQ_CONTINUATION_BIT) !== 0;
      value += (digit & VLQ_VALUE_MASK) << shift;
      shift += 5;
    }

    // Convert from VLQ sign representation
    // Least significant bit is the sign (1 = negative)
    const isNegative = (value & 1) !== 0;
    value >>= 1;
    values.push(isNegative ? -value : value);
  }

  return values;
}

/**
 * Group mapping segments by source file index.
 * Returns a Map from sourceIndex → array of segments for that source.
 */
export function groupBySource(segments: MappingSegment[]): Map<number, MappingSegment[]> {
  const groups = new Map<number, MappingSegment[]>();

  for (const seg of segments) {
    if (seg.sourceIndex < 0) continue;
    let list = groups.get(seg.sourceIndex);
    if (!list) {
      list = [];
      groups.set(seg.sourceIndex, list);
    }
    list.push(seg);
  }

  return groups;
}

/**
 * Extract all name references from the mappings for a specific source file.
 * Returns pairs of [originalLine, originalColumn, nameIndex].
 */
export function extractNameReferences(
  segments: MappingSegment[]
): Array<{ line: number; column: number; nameIndex: number }> {
  return segments
    .filter((s) => s.nameIndex >= 0)
    .map((s) => ({
      line: s.originalLine,
      column: s.originalColumn,
      nameIndex: s.nameIndex,
    }));
}
