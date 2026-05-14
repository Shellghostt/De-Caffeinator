// ============================================================
// STAGE 2 — HEADER INSPECTOR
// Checks HTTP response headers for SourceMap: or X-SourceMap:
// Some servers (Rails, certain Node middleware) emit these
// instead of or in addition to inline comments.
// ============================================================

export interface HeaderScanResult {
  found: boolean;
  url?: string;
}

export function inspectHeaders(
  headers: Record<string, string>,
  assetUrl: string
): HeaderScanResult {
  // Both header names are valid per the spec
  const raw =
    headers["sourcemap"] ??
    headers["x-sourcemap"] ??
    headers["SourceMap"] ??
    headers["X-SourceMap"];

  if (!raw || raw.trim() === "") return { found: false };

  try {
    const resolved = new URL(raw.trim(), assetUrl).href;
    return { found: true, url: resolved };
  } catch {
    return { found: false };
  }
}
