// ============================================================
// STAGE 2 — HEADER INSPECTOR
// Checks HTTP response headers for SourceMap: or X-SourceMap:
// ============================================================

export interface HeaderScanResult {
  found: boolean;
  url?: string;
}

export function inspectHeaders(
  headers: Record<string, string>,
  assetUrl: string
): HeaderScanResult {
  // fetchUrl lowercases all header keys — only read lowercase forms
  const raw = headers["sourcemap"] ?? headers["x-sourcemap"];

  if (!raw || raw.trim() === "") return { found: false };

  try {
    const resolved = new URL(raw.trim(), assetUrl).href;
    return { found: true, url: resolved };
  } catch {
    return { found: false };
  }
}
