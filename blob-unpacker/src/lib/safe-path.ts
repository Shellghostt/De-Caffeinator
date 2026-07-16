// ============================================================
// SAFE PATH HELPERS
// Prevent path traversal when writing reconstructed sources.
// ============================================================

import * as path from "path";

/**
 * Sanitize a source-map path into a relative, platform-safe path.
 * Strips absolute roots, drive letters, UNC, and `..` segments.
 */
export function sanitizeSourcePath(p: string): string {
  let normalized = p.replace(/\\/g, "/");

  // Drop URL/scheme prefixes (webpack://, file://, etc.)
  normalized = normalized.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");

  // Drop Windows drive / UNC
  normalized = normalized.replace(/^[a-zA-Z]:/, "");
  normalized = normalized.replace(/^\/+/, "");

  const parts = normalized.split("/").filter((seg) => {
    if (!seg || seg === ".") return false;
    if (seg === "..") return false;
    return true;
  });

  if (parts.length === 0) return "_unnamed";
  return parts.join(path.sep);
}

/**
 * True if `candidate` resolves strictly inside `baseDir` (or is baseDir itself).
 * Uses a separator-terminated prefix check to avoid `abc` / `abc_evil` bypass.
 */
export function isPathInside(baseDir: string, candidate: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidate);

  if (resolvedCandidate === resolvedBase) return true;

  const prefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;

  return resolvedCandidate.startsWith(prefix);
}
