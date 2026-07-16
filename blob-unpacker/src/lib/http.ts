// ============================================================
// BLOB UNPACKER — HTTP CLIENT
// Shared fetch wrapper with timeout, retry, per-host rate
// limiting, SSRF guards, redirect policy, and body size caps.
// ============================================================

import * as dns from "dns/promises";
import * as net from "net";
import { PipelineContext } from "../core/context";

export interface FetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Default max response body size (10 MiB) when config omits it */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Max redirects to follow while re-validating each hop */
const MAX_REDIRECTS = 5;

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

// Per-context rate-limit state (avoids cross-run coupling)
const rateLimitState = new WeakMap<
  PipelineContext,
  Map<string, { lastAt: number; chain: Promise<void> }>
>();

function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRateMap(ctx: PipelineContext): Map<string, { lastAt: number; chain: Promise<void> }> {
  let map = rateLimitState.get(ctx);
  if (!map) {
    map = new Map();
    rateLimitState.set(ctx, map);
  }
  return map;
}

/** Serialize politeness delay per host so concurrent callers do not burst. */
async function applyRateLimit(host: string, delayMs: number, ctx: PipelineContext): Promise<void> {
  if (delayMs <= 0) return;

  const map = getRateMap(ctx);
  const entry = map.get(host) ?? { lastAt: 0, chain: Promise.resolve() };

  const next = entry.chain.then(async () => {
    const elapsed = Date.now() - entry.lastAt;
    if (elapsed < delayMs) {
      await sleep(delayMs - elapsed);
    }
    entry.lastAt = Date.now();
  });

  entry.chain = next.catch(() => undefined);
  map.set(host, entry);
  await next;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ip: string, base: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** True for loopback, RFC1918, link-local, CGNAT, and similar non-public ranges. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");

  if (net.isIPv4(v)) {
    if (inCidr(v, "0.0.0.0", 8)) return true;
    if (inCidr(v, "10.0.0.0", 8)) return true;
    if (inCidr(v, "127.0.0.0", 8)) return true;
    if (inCidr(v, "169.254.0.0", 16)) return true; // link-local / AWS metadata
    if (inCidr(v, "172.16.0.0", 12)) return true;
    if (inCidr(v, "192.168.0.0", 16)) return true;
    if (inCidr(v, "100.64.0.0", 10)) return true; // CGNAT
    if (inCidr(v, "192.0.0.0", 24)) return true;
    if (inCidr(v, "198.18.0.0", 15)) return true; // benchmarking
    if (inCidr(v, "224.0.0.0", 4)) return true; // multicast
    if (inCidr(v, "240.0.0.0", 4)) return true; // reserved
    return false;
  }

  if (net.isIPv6(v)) {
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // ULA
    if (v.startsWith("fe80")) return true; // link-local
    // IPv4-mapped :ffff:x.x.x.x
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }

  return false;
}

/**
 * Validate that a URL is safe to fetch (scheme + hostname + resolved IPs).
 * Throws on policy violation.
 */
export async function assertUrlAllowed(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Blocked URL: invalid URL "${url}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked URL: scheme "${parsed.protocol}" not allowed`);
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (!host || BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error(`Blocked URL: hostname "${host}" is not allowed`);
  }

  // Literal IP in the URL
  if (net.isIP(host) && isPrivateOrReservedIp(host)) {
    throw new Error(`Blocked URL: private/reserved IP "${host}"`);
  }

  // Resolve DNS and reject private answers (mitigates basic SSRF / rebinding to LAN)
  if (!net.isIP(host)) {
    try {
      const results = await dns.lookup(host, { all: true, verbatim: true });
      if (results.length === 0) {
        throw new Error(`Blocked URL: hostname "${host}" did not resolve`);
      }
      for (const r of results) {
        if (isPrivateOrReservedIp(r.address)) {
          throw new Error(
            `Blocked URL: hostname "${host}" resolves to private/reserved IP ${r.address}`
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Blocked URL:")) throw err;
      throw new Error(`Blocked URL: DNS lookup failed for "${host}": ${msg}`);
    }
  }

  return parsed;
}

/** True if finalUrl shares the same origin as expectedOrigin (protocol + host + port). */
export function sameOrigin(expectedOrigin: string, finalUrl: string): boolean {
  try {
    return new URL(expectedOrigin).origin === new URL(finalUrl).origin;
  } catch {
    return false;
  }
}

async function readBodyCapped(
  res: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const len = parseInt(contentLength, 10);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error(`Response too large: Content-Length ${len} exceeds limit ${maxBytes}`);
    }
  }

  if (!res.body) {
    return "";
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((val, key) => {
    out[key.toLowerCase()] = val;
  });
  return out;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function fetchUrl(
  url: string,
  ctx: PipelineContext,
  retries = 2
): Promise<FetchResult> {
  const maxBytes =
    ctx.config.http.max_response_bytes > 0
      ? ctx.config.http.max_response_bytes
      : DEFAULT_MAX_RESPONSE_BYTES;

  let current = url;
  let redirectCount = 0;

  while (true) {
    await assertUrlAllowed(current);
    const host = getHost(current);
    await applyRateLimit(host, ctx.config.http.delay_between_ms, ctx);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.config.http.timeout_ms);

    try {
      const res = await fetch(current, {
        signal: controller.signal,
        headers: { "User-Agent": ctx.config.http.user_agent },
        redirect: "manual",
      });

      // Manual redirect following with per-hop SSRF checks
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return {
            url: current,
            status: res.status,
            headers: headersToRecord(res.headers),
            body: "",
          };
        }
        redirectCount += 1;
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS}) for ${url}`);
        }
        current = new URL(location, current).href;
        continue;
      }

      if (!res.ok && isRetryableStatus(res.status) && retries > 0) {
        ctx.logger.warn(`Retrying ${current} after HTTP ${res.status} (${retries} left)`, {
          asset_url: url,
        });
        await sleep(500 * (3 - retries));
        return fetchUrl(url, ctx, retries - 1);
      }

      const body = await readBodyCapped(res, maxBytes);
      return {
        url: res.url || current,
        status: res.status,
        headers: headersToRecord(res.headers),
        body,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isBlocked = msg.startsWith("Blocked URL:") || msg.startsWith("Response too large:");

      if (isBlocked) throw err;

      if (retries > 0 && !isAbort) {
        ctx.logger.warn(`Retrying ${current} (${retries} left)`, { asset_url: url });
        await sleep(500 * (3 - retries));
        return fetchUrl(url, ctx, retries - 1);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** HEAD request to check existence without downloading body */
export async function headUrl(
  url: string,
  ctx: PipelineContext,
  redirectDepth = 0
): Promise<{ exists: boolean; headers: Record<string, string> }> {
  if (redirectDepth > MAX_REDIRECTS) {
    return { exists: false, headers: {} };
  }

  try {
    await assertUrlAllowed(url);
  } catch {
    return { exists: false, headers: {} };
  }

  const host = getHost(url);
  await applyRateLimit(host, ctx.config.http.delay_between_ms, ctx);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.config.http.timeout_ms);

  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers: { "User-Agent": ctx.config.http.user_agent },
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        const next = new URL(location, url).href;
        return headUrl(next, ctx, redirectDepth + 1);
      }
    }

    const headers = headersToRecord(res.headers);
    return { exists: res.ok, headers };
  } catch {
    return { exists: false, headers: {} };
  } finally {
    clearTimeout(timer);
  }
}
