// ============================================================
// BLOB UNPACKER — HTTP CLIENT
// Shared fetch wrapper with timeout, retry, per-host rate
// limiting, and response validation.
// ============================================================

import { PipelineContext } from "../core/context";

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

// Track last request time per host for rate limiting
const lastRequestTime = new Map<string, number>();

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

async function applyRateLimit(host: string, delayMs: number): Promise<void> {
  const last = lastRequestTime.get(host) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < delayMs) {
    await sleep(delayMs - elapsed);
  }
  lastRequestTime.set(host, Date.now());
}

export async function fetchUrl(
  url: string,
  ctx: PipelineContext,
  retries = 2
): Promise<FetchResult> {
  const host = getHost(url);
  await applyRateLimit(host, ctx.config.http.delay_between_ms);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.http.timeout_ms);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": ctx.config.http.user_agent },
    });

    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });

    return { url: res.url, status: res.status, headers, body };
  } catch (err) {
    if (retries > 0) {
      ctx.logger.warn(`Retrying ${url} (${retries} left)`, { asset_url: url });
      await sleep(500);
      return fetchUrl(url, ctx, retries - 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** HEAD request to check existence without downloading body */
export async function headUrl(
  url: string,
  ctx: PipelineContext
): Promise<{ exists: boolean; headers: Record<string, string> }> {
  const host = getHost(url);
  await applyRateLimit(host, ctx.config.http.delay_between_ms);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.http.timeout_ms);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": ctx.config.http.user_agent },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
    return { exists: res.ok, headers };
  } catch {
    return { exists: false, headers: {} };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
