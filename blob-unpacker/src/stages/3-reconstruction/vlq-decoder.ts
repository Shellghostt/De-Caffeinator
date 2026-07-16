// ============================================================
// STAGE 3 — VLQ DECODER
// Decodes the Base64 VLQ-encoded 'mappings' string from a
// Source Map v3 file into structured position mappings.
// ============================================================

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Map<string, number>();
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP.set(B64_CHARS[i], i);
}

const VLQ_CONTINUATION_BIT = 0x20;
const VLQ_VALUE_MASK = 0x1f;
const MAX_MAPPINGS_CHARS = 5_000_000;
const MAX_SEGMENTS = 2_000_000;
const MAX_VLQ_DIGITS = 16;

export interface MappingSegment {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
  nameIndex: number;
}

export function decodeMappings(mappings: string): MappingSegment[] {
  const result: MappingSegment[] = [];

  if (!mappings || mappings.length === 0) return result;
  if (mappings.length > MAX_MAPPINGS_CHARS) {
    throw new Error(`mappings string exceeds ${MAX_MAPPINGS_CHARS} characters`);
  }

  let generatedLine = 0;
  let generatedColumn = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  const groups = mappings.split(";");

  for (const group of groups) {
    generatedColumn = 0;

    if (group.length === 0) {
      generatedLine++;
      continue;
    }

    const segments = group.split(",");

    for (const segment of segments) {
      if (segment.length === 0) continue;
      if (result.length >= MAX_SEGMENTS) {
        throw new Error(`mappings exceed ${MAX_SEGMENTS} segments`);
      }

      const decoded = decodeVLQSegment(segment);
      if (decoded.length === 0) continue;

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
        sourceIndex += decoded[1];
        originalLine += decoded[2];
        originalColumn += decoded[3];

        mapping.sourceIndex = sourceIndex;
        mapping.originalLine = originalLine;
        mapping.originalColumn = originalColumn;
      }

      if (decoded.length >= 5) {
        nameIndex += decoded[4];
        mapping.nameIndex = nameIndex;
      }

      result.push(mapping);
    }

    generatedLine++;
  }

  return result;
}

function decodeVLQSegment(segment: string): number[] {
  const values: number[] = [];
  let i = 0;

  while (i < segment.length) {
    let value = 0;
    let shift = 0;
    let continuation = true;
    let digits = 0;

    while (continuation && i < segment.length) {
      if (++digits > MAX_VLQ_DIGITS) {
        throw new Error("VLQ continuation too long");
      }
      const char = segment[i++];
      const digit = B64_LOOKUP.get(char);
      if (digit === undefined) break;

      continuation = (digit & VLQ_CONTINUATION_BIT) !== 0;
      value += (digit & VLQ_VALUE_MASK) << shift;
      shift += 5;
    }

    const isNegative = (value & 1) !== 0;
    value >>= 1;
    values.push(isNegative ? -value : value);
  }

  return values;
}

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
