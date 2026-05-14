// ============================================================
// BLOB UNPACKER — CHUNK DISCOVERER
// Scans JavaScript source to find references to dynamically
// loaded chunks that wouldn't appear in static HTML:
//   - ES dynamic import()
//   - Webpack __webpack_require__.e() chunk loading
//   - Webpack webpackJsonp / push patterns
//   - React.lazy() and loadable components
//   - Vite/Rollup dynamic chunk patterns
//   - Explicit chunk URL construction patterns
// ============================================================

export interface DiscoveredChunk {
  /** The raw reference found (may be partial path or full URL) */
  raw: string;
  /** The source pattern that discovered it */
  source: "dynamic_import" | "webpack_require" | "webpack_jsonp" | "react_lazy" | "chunk_url_pattern" | "vite_glob";
}

// ── Dynamic import() ────────────────────────────────────────
// import("./pages/About")  |  import("./chunk-abc123.js")
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["'`]([^"'`]+\.(?:js|mjs|jsx|ts|tsx))["'`]\s*\)/g;

// Also catch imports without extension (bundlers resolve them):
// import("./pages/About")
const DYNAMIC_IMPORT_NO_EXT_RE = /\bimport\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;

// ── Webpack __webpack_require__.e(chunkId) ──────────────────
// __webpack_require__.e(/*! import() */ 42)
// __webpack_require__.e(/*! import() | about */ "about")
const WEBPACK_REQUIRE_E_RE = /__webpack_require__\.e\s*\(\s*(?:\/\*[^*]*\*\/\s*)*["']?([^)"'\s,]+)["']?\s*\)/g;

// ── Webpack chunk loading: __webpack_require__.f.j ──────────
// Used in Webpack 5 for JSONP chunk loading
const WEBPACK_F_J_RE = /__webpack_require__\.f\.j\s*=\s*function\s*\(([^)]*)\)/g;

// ── Webpack chunk URL construction ──────────────────────────
// __webpack_require__.p + __webpack_require__.u(chunkId)
// These often appear as: "" + chunkId + "." + {"about":"abc123"}[chunkId] + ".js"
// Or: __webpack_require__.u = function(e) { return ... }
const WEBPACK_CHUNK_MAP_RE = /(?:__webpack_require__\.u\s*=|__webpack_require__\.p\s*\+)\s*[^;]+?["']([^"']+\.[a-f0-9]+\.js)["']/g;

// Broader: detect any chunk filename patterns in string literals
// "static/js/42.abc123.chunk.js"  |  "js/chunk-about.9f8e7d.js"
const CHUNK_PATH_LITERAL_RE = /["']((?:static\/|assets\/|js\/|chunks?\/)?(?:chunk[.-]|[\d]+\.)[a-f0-9]{4,}(?:\.chunk)?\.(?:js|mjs))["']/gi;

// ── webpackJsonp / self["webpackChunk..."].push ─────────────
// Extracts referenced chunk IDs from the bootstrap
const WEBPACK_JSONP_RE = /(?:webpackJsonp|webpackChunk[a-zA-Z_]*)\s*(?:=\s*(?:self|window|globalThis)\s*\[["'][^"']+["']\])?\s*(?:\.push|=\s*)\s*\(\s*\[\s*\[\s*([\d,\s]+)\]/g;

// ── React.lazy(() => import(...)) ───────────────────────────
const REACT_LAZY_RE = /(?:React\.lazy|lazy)\s*\(\s*\(\)\s*=>\s*(?:__webpack_require__\.e\([^)]*\)|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\))/g;

// ── Vite glob import patterns ───────────────────────────────
// import.meta.glob("./pages/*.tsx")
const VITE_GLOB_RE = /import\.meta\.glob\s*\(\s*["'`]([^"'`]+)["'`]/g;

// ── Generic publicPath + chunk patterns ─────────────────────
// e.g. "https://cdn.example.com/js/" used as prefix
const PUBLIC_PATH_RE = /(?:__webpack_require__\.p|__webpack_public_path__|publicPath)\s*=\s*["']([^"']+)["']/g;

/**
 * Scan JS source code for references to dynamically loaded chunks.
 * Returns raw references — the caller resolves them to full URLs.
 */
export function discoverChunks(jsContent: string): DiscoveredChunk[] {
  const found: DiscoveredChunk[] = [];
  const seen = new Set<string>();

  const add = (raw: string, source: DiscoveredChunk["source"]) => {
    const normalized = raw.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      found.push({ raw: normalized, source });
    }
  };

  // Dynamic import() with extension
  for (const m of matchAll(jsContent, DYNAMIC_IMPORT_RE)) {
    add(m[1], "dynamic_import");
  }

  // Dynamic import() without extension — append .js
  for (const m of matchAll(jsContent, DYNAMIC_IMPORT_NO_EXT_RE)) {
    if (!seen.has(m[1]) && !seen.has(m[1] + ".js")) {
      add(m[1] + ".js", "dynamic_import");
    }
  }

  // Webpack __webpack_require__.e()
  for (const m of matchAll(jsContent, WEBPACK_REQUIRE_E_RE)) {
    add(m[1], "webpack_require");
  }

  // Chunk path literals (files named like chunks)
  for (const m of matchAll(jsContent, CHUNK_PATH_LITERAL_RE)) {
    add(m[1], "chunk_url_pattern");
  }

  // Webpack chunk map URLs
  for (const m of matchAll(jsContent, WEBPACK_CHUNK_MAP_RE)) {
    add(m[1], "chunk_url_pattern");
  }

  // React.lazy import references
  for (const m of matchAll(jsContent, REACT_LAZY_RE)) {
    if (m[1]) add(m[1], "react_lazy");
  }

  // Vite glob patterns — these are directory globs, mark them for expansion
  for (const m of matchAll(jsContent, VITE_GLOB_RE)) {
    add(m[1], "vite_glob");
  }

  // webpackJsonp chunk IDs — these are numeric IDs, not URLs
  // We still record them; the caller can try to resolve via the chunk map
  for (const m of matchAll(jsContent, WEBPACK_JSONP_RE)) {
    const ids = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      add(id, "webpack_jsonp");
    }
  }

  return found;
}

/**
 * Extract the publicPath (CDN base URL) from Webpack bootstrap code.
 * Returns null if not found.
 */
export function extractPublicPath(jsContent: string): string | null {
  const m = PUBLIC_PATH_RE.exec(jsContent);
  return m ? m[1] : null;
}

/**
 * Resolve a discovered chunk reference to full URLs.
 * Returns an array because some references might resolve to multiple candidates.
 */
export function resolveChunkRef(
  chunk: DiscoveredChunk,
  assetUrl: string,
  publicPath: string | null
): string[] {
  const raw = chunk.raw;

  // Skip numeric-only Webpack chunk IDs — can't resolve without a chunk map
  if (/^\d+$/.test(raw)) return [];

  // Skip glob patterns — we'd need directory listing
  if (raw.includes("*")) return [];

  const candidates: string[] = [];
  const bases: string[] = [];

  // Build candidate base URLs
  if (publicPath) {
    bases.push(publicPath);
  }

  // Derive base from the asset URL (e.g., https://example.com/static/js/main.js → https://example.com/static/js/)
  try {
    const assetBase = new URL(".", assetUrl).href;
    bases.push(assetBase);

    // Also try one level up (common: chunks sit next to the main bundle)
    const parentBase = new URL("..", assetUrl).href;
    bases.push(parentBase);

    // Also try the origin root
    const origin = new URL(assetUrl).origin + "/";
    bases.push(origin);
  } catch {
    // Not a valid URL — skip
  }

  // If there are no bases, we can't resolve
  if (bases.length === 0) return [];

  // Resolve against each base
  const resolvedSet = new Set<string>();
  for (const base of bases) {
    try {
      const resolved = new URL(raw, base).href;
      if (!resolvedSet.has(resolved)) {
        resolvedSet.add(resolved);
        candidates.push(resolved);
      }
    } catch {
      // Malformed URL — skip
    }
  }

  return candidates;
}

// ----------------------------------------------------------
// HELPER
// ----------------------------------------------------------

function matchAll(text: string, re: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m);
    // Safety: prevent infinite loops on zero-width matches
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return results;
}
