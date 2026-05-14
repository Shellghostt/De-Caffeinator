// ============================================================
// STAGE 3 — MAP PARSER (Enhanced)
// Parses and validates source map JSON.
// Normalizes the wildly different path formats emitted by
// Webpack, Vite, Rollup, esbuild, Parcel, Turbopack, and more.
//
// Supports:
//   - Standard Source Map v3
//   - Index Source Maps (sections field)
//   - sourceRoot resolution
//   - Path normalization for all major bundlers
// ============================================================

export interface ParsedSourceMap {
  version: number;
  sources: string[];           // normalized file paths
  sourcesContent: (string | null)[] | null;
  names: string[];
  mappings: string;
  sourceRoot: string | null;
  /** Original 'file' field — the name of the generated file */
  file: string | null;
}

// Protocol/namespace prefixes injected by various build tools
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
  /^\/\.\//,      // /./src/...
  /^\.\//,        // ./src/...
];

export function parseSourceMap(raw: string): ParsedSourceMap {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Source map is not valid JSON");
  }

  // Handle index source maps (sections field)
  if (Array.isArray(json["sections"])) {
    return parseIndexMap(json);
  }

  if (json["version"] !== 3) {
    throw new Error(`Unsupported source map version: ${json["version"]}`);
  }

  const sources = (json["sources"] as string[] ?? []).map(normalizePath);
  const sourceRoot = typeof json["sourceRoot"] === "string" && json["sourceRoot"].length > 0
    ? json["sourceRoot"]
    : null;
  const file = typeof json["file"] === "string" ? json["file"] : null;

  // Apply sourceRoot to relative paths
  const resolvedSources = sourceRoot
    ? sources.map((s) => (s.startsWith("/") ? s : joinPaths(sourceRoot, s)))
    : sources;

  // Normalize sourcesContent — handle null entries and mismatched lengths
  let sourcesContent: (string | null)[] | null = null;
  if (Array.isArray(json["sourcesContent"])) {
    const raw = json["sourcesContent"] as unknown[];
    sourcesContent = resolvedSources.map((_, i) => {
      const entry = raw[i];
      return typeof entry === "string" ? entry : null;
    });
  }

  return {
    version: 3,
    sources: resolvedSources.map(normalizePath),
    sourcesContent,
    names: (json["names"] as string[]) ?? [],
    mappings: (json["mappings"] as string) ?? "",
    sourceRoot,
    file,
  };
}

/**
 * Parse an index source map (one with a 'sections' field).
 * Each section has an offset and a nested map. We merge them
 * into a single flat ParsedSourceMap.
 */
function parseIndexMap(json: Record<string, unknown>): ParsedSourceMap {
  const sections = json["sections"] as Array<{
    offset: { line: number; column: number };
    map: Record<string, unknown>;
  }>;

  const allSources: string[] = [];
  const allSourcesContent: (string | null)[] = [];
  const allNames: string[] = [];
  // We can't easily merge mappings, so we concatenate them with proper offsets
  // For now, collect all sources/content for reconstruction
  let mergedMappings = "";

  for (const section of sections) {
    const sectionMap = section.map;
    if (!sectionMap) continue;

    const sources = ((sectionMap["sources"] as string[]) ?? []).map(normalizePath);
    const sourceRoot = typeof sectionMap["sourceRoot"] === "string"
      ? sectionMap["sourceRoot"]
      : null;
    const resolvedSources = sourceRoot
      ? sources.map((s) => (s.startsWith("/") ? s : joinPaths(sourceRoot, s)))
      : sources;

    // Adjust source indices — offset by current total
    const sourceOffset = allSources.length;
    allSources.push(...resolvedSources.map(normalizePath));

    if (Array.isArray(sectionMap["sourcesContent"])) {
      const content = sectionMap["sourcesContent"] as (string | null)[];
      allSourcesContent.push(...content);
    } else {
      allSourcesContent.push(...resolvedSources.map(() => null));
    }

    if (Array.isArray(sectionMap["names"])) {
      allNames.push(...(sectionMap["names"] as string[]));
    }

    // Append section mappings (simplified — proper offset handling would need VLQ rewriting)
    const sectionMappings = (sectionMap["mappings"] as string) ?? "";
    if (sectionMappings) {
      if (mergedMappings) {
        // Add line separators for the offset
        const lineOffset = section.offset.line;
        const padding = ";".repeat(Math.max(0, lineOffset));
        mergedMappings += padding + sectionMappings;
      } else {
        mergedMappings = sectionMappings;
      }
    }
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

export function normalizePath(p: string): string {
  let result = p;
  for (const prefix of STRIP_PREFIXES) {
    result = result.replace(prefix, "");
  }
  // Remove double slashes, resolve ../ sequences
  result = result.replace(/\/\//g, "/");
  const parts = result.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }
  return resolved.join("/");
}

/** True if all sources have non-null, non-empty content */
export function hasFullContent(map: ParsedSourceMap): boolean {
  if (!map.sourcesContent || map.sourcesContent.length === 0) return false;
  return (
    map.sourcesContent.length === map.sources.length &&
    map.sourcesContent.every((c) => typeof c === "string" && c.length > 0)
  );
}

/** True if some (but not all) sources have content */
export function hasPartialContent(map: ParsedSourceMap): boolean {
  if (!map.sourcesContent) return false;
  const hasAny = map.sourcesContent.some((c) => typeof c === "string" && c.length > 0);
  const missingAny = map.sourcesContent.some((c) => !c);
  return hasAny && missingAny;
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function joinPaths(root: string, relative: string): string {
  // Clean up root trailing slash
  const cleanRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return `${cleanRoot}/${relative}`;
}
