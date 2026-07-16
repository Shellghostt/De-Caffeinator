// ============================================================
// STAGE 3 — MAP PARSER (Enhanced)
// Parses and validates source map JSON.
// Normalizes the wildly different path formats emitted by
// Webpack, Vite, Rollup, esbuild, Parcel, Turbopack, and more.
//
// Supports:
//   - Standard Source Map v3
//   - Index Source Maps (sections) with remapped source/name indices
//   - sourceRoot resolution
//   - Path normalization for all major bundlers
// ============================================================

export interface ParsedSourceMap {
  version: number;
  sources: string[];
  sourcesContent: (string | null)[] | null;
  names: string[];
  mappings: string;
  sourceRoot: string | null;
  file: string | null;
}

const STRIP_PREFIXES = [
  /^webpack:\/\/\//,
  /^webpack:\/\//,
  /^webpack-internal:\/\/\//,
  /^ng:\/\/\//,
  /^ng:\/\//,
  /^vite:\/@fs\//,
  /^vite:\//,
  /^\/@fs\//,
  /^turbopack:\/\/\[project\]\//,
  /^turbopack:\/\/\//,
  /^turbopack:\//,
  /^parcel:\/\/\//,
  /^parcel:\//,
  /^esbuild:\//,
  /^file:\/\/\//,
  /^file:\/\//,
  /^\/\.\//,
  /^\.\//,
];

const MAX_MAPPINGS_CHARS = 5_000_000;
const MAX_INDEX_SECTIONS = 500;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = new Map<string, number>();
for (let i = 0; i < B64.length; i++) B64_LOOKUP.set(B64[i], i);

export function parseSourceMap(raw: string): ParsedSourceMap {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Source map is not valid JSON");
  }

  if (Array.isArray(json["sections"])) {
    return parseIndexMap(json);
  }

  if (json["version"] !== 3) {
    throw new Error(`Unsupported source map version: ${json["version"]}`);
  }

  const sources = (json["sources"] as string[] ?? []).map(normalizePath);
  const sourceRoot =
    typeof json["sourceRoot"] === "string" && json["sourceRoot"].length > 0
      ? json["sourceRoot"]
      : null;
  const file = typeof json["file"] === "string" ? json["file"] : null;

  const resolvedSources = sourceRoot
    ? sources.map((s) => (s.startsWith("/") ? s : joinPaths(sourceRoot, s)))
    : sources;

  let sourcesContent: (string | null)[] | null = null;
  if (Array.isArray(json["sourcesContent"])) {
    const contentArr = json["sourcesContent"] as unknown[];
    sourcesContent = resolvedSources.map((_, i) => {
      const entry = contentArr[i];
      return typeof entry === "string" ? entry : null;
    });
  }

  const mappings = (json["mappings"] as string) ?? "";
  if (mappings.length > MAX_MAPPINGS_CHARS) {
    throw new Error(`Source map mappings exceed ${MAX_MAPPINGS_CHARS} characters`);
  }

  return {
    version: 3,
    sources: resolvedSources.map(normalizePath),
    sourcesContent,
    names: (json["names"] as string[]) ?? [],
    mappings,
    sourceRoot,
    file,
  };
}

/**
 * Merge index-map sections into one flat map.
 * Remaps source/name VLQ indices into shared arrays and pads
 * generated lines to each section's absolute offset.
 */
function parseIndexMap(json: Record<string, unknown>): ParsedSourceMap {
  const sections = json["sections"] as Array<{
    offset: { line: number; column: number };
    map: Record<string, unknown>;
  }>;

  if (sections.length > MAX_INDEX_SECTIONS) {
    throw new Error(`Index source map has too many sections (${sections.length})`);
  }

  const allSources: string[] = [];
  const allSourcesContent: (string | null)[] = [];
  const allNames: string[] = [];
  const mappingLines: string[] = [];

  for (const section of sections) {
    const sectionMap = section.map;
    if (!sectionMap) continue;

    const sources = ((sectionMap["sources"] as string[]) ?? []).map(normalizePath);
    const sourceRoot =
      typeof sectionMap["sourceRoot"] === "string" ? sectionMap["sourceRoot"] : null;
    const resolvedSources = sourceRoot
      ? sources.map((s) => (s.startsWith("/") ? s : joinPaths(sourceRoot, s)))
      : sources;

    const sourceOffset = allSources.length;
    const nameOffset = allNames.length;

    allSources.push(...resolvedSources.map(normalizePath));

    if (Array.isArray(sectionMap["sourcesContent"])) {
      const content = sectionMap["sourcesContent"] as (string | null)[];
      for (let i = 0; i < resolvedSources.length; i++) {
        const entry = content[i];
        allSourcesContent.push(typeof entry === "string" ? entry : null);
      }
    } else {
      allSourcesContent.push(...resolvedSources.map(() => null));
    }

    const sectionNames = Array.isArray(sectionMap["names"])
      ? (sectionMap["names"] as string[])
      : [];
    allNames.push(...sectionNames);

    const sectionMappings = (sectionMap["mappings"] as string) ?? "";
    const targetLine = Math.max(0, section.offset?.line ?? 0);

    while (mappingLines.length < targetLine) {
      mappingLines.push("");
    }

    const remapped = remapSectionMappings(sectionMappings, sourceOffset, nameOffset);
    const remappedLines = remapped.split(";");

    for (let i = 0; i < remappedLines.length; i++) {
      const lineIdx = targetLine + i;
      while (mappingLines.length < lineIdx) {
        mappingLines.push("");
      }
      if (mappingLines.length === lineIdx) {
        mappingLines.push(remappedLines[i]);
      } else {
        // Merge into existing line at this offset
        const existing = mappingLines[lineIdx];
        mappingLines[lineIdx] = existing
          ? remappedLines[i]
            ? existing + "," + remappedLines[i]
            : existing
          : remappedLines[i];
      }
    }
  }

  const mergedMappings = mappingLines.join(";");
  if (mergedMappings.length > MAX_MAPPINGS_CHARS) {
    throw new Error(`Merged index map mappings exceed ${MAX_MAPPINGS_CHARS} characters`);
  }

  return {
    version: 3,
    sources: allSources,
    sourcesContent: allSourcesContent.some((c) => c !== null) ? allSourcesContent : null,
    names: allNames,
    mappings: mergedMappings,
    sourceRoot: null,
    file: typeof json["file"] === "string" ? json["file"] : null,
  };
}

/**
 * Rewrite a section's mappings so sourceIndex/nameIndex are offset into
 * the merged arrays. Uses absolute-index tracking then re-encodes deltas.
 */
function remapSectionMappings(
  mappings: string,
  sourceOffset: number,
  nameOffset: number
): string {
  if (!mappings) return "";
  if (sourceOffset === 0 && nameOffset === 0) return mappings;

  const groups = mappings.split(";");
  let genCol = 0;
  let srcAbs = 0;
  let origLine = 0;
  let origCol = 0;
  let nameAbs = 0;

  // Output-side previous absolute values (with offsets applied)
  let outSrc = 0;
  let outOrigLine = 0;
  let outOrigCol = 0;
  let outName = 0;
  let outGenCol = 0;
  let firstSegOfSection = true;

  return groups
    .map((group) => {
      genCol = 0;
      outGenCol = 0;
      if (!group) return "";

      return group
        .split(",")
        .filter((s) => s.length > 0)
        .map((segment) => {
          const values = decodeVLQValues(segment);
          if (values.length === 0) return "";

          genCol += values[0];
          const out: number[] = [genCol - outGenCol];
          outGenCol = genCol;

          if (values.length >= 4) {
            srcAbs += values[1];
            origLine += values[2];
            origCol += values[3];

            const adjSrc = srcAbs + sourceOffset;
            out.push(firstSegOfSection ? adjSrc - outSrc : adjSrc - outSrc);
            out.push(origLine - outOrigLine);
            out.push(origCol - outOrigCol);
            outSrc = adjSrc;
            outOrigLine = origLine;
            outOrigCol = origCol;
            firstSegOfSection = false;
          }

          if (values.length >= 5) {
            nameAbs += values[4];
            const adjName = nameAbs + nameOffset;
            out.push(adjName - outName);
            outName = adjName;
          }

          return encodeVLQValues(out);
        })
        .join(",");
    })
    .join(";");
}

function decodeVLQValues(segment: string): number[] {
  const values: number[] = [];
  let i = 0;
  while (i < segment.length) {
    let value = 0;
    let shift = 0;
    let continuation = true;
    let steps = 0;
    while (continuation && i < segment.length) {
      if (++steps > 16) break; // reject overlong VLQ digits
      const digit = B64_LOOKUP.get(segment[i++]);
      if (digit === undefined) break;
      continuation = (digit & 0x20) !== 0;
      value += (digit & 0x1f) << shift;
      shift += 5;
    }
    const isNegative = (value & 1) !== 0;
    value >>= 1;
    values.push(isNegative ? -value : value);
  }
  return values;
}

function encodeVLQValues(values: number[]): string {
  let out = "";
  for (const v of values) {
    let vlq = v < 0 ? ((-v) << 1) | 1 : v << 1;
    do {
      let digit = vlq & 0x1f;
      vlq >>>= 5;
      if (vlq > 0) digit |= 0x20;
      out += B64[digit];
    } while (vlq > 0);
  }
  return out;
}

export function normalizePath(p: string): string {
  let result = p.replace(/\\/g, "/");
  for (const prefix of STRIP_PREFIXES) {
    result = result.replace(prefix, "");
  }
  result = result.replace(/\/\//g, "/");
  const parts = result.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (resolved.length === 0) {
        // Unresolved .. — drop it rather than escaping the tree
        continue;
      }
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }
  return resolved.join("/") || "_unnamed";
}

export function hasFullContent(map: ParsedSourceMap): boolean {
  if (!map.sourcesContent || map.sourcesContent.length === 0) return false;
  return (
    map.sourcesContent.length === map.sources.length &&
    map.sourcesContent.every((c) => typeof c === "string" && c.length > 0)
  );
}

export function hasPartialContent(map: ParsedSourceMap): boolean {
  if (!map.sourcesContent) return false;
  const hasAny = map.sourcesContent.some((c) => typeof c === "string" && c.length > 0);
  const missingAny = map.sourcesContent.some((c) => !c);
  return hasAny && missingAny;
}

function joinPaths(root: string, relative: string): string {
  const cleanRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${cleanRoot}/${relative}`;
}
