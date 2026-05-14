// ============================================================
// BLOB UNPACKER — PRIORITY & DEDUP QUEUE
// Traffic controller: deduplication, priority ordering,
// and concurrency tracking for in-flight assets.
// ============================================================

import { AssetRecord, AssetType } from "../types/contracts";
import { PipelineContext } from "./context";

// ----------------------------------------------------------
// PRIORITY MAP
// Lower number = higher priority (processed first)
// ----------------------------------------------------------

const ASSET_PRIORITY: Record<AssetType, number> = {
  main_bundle: 0,
  chunk: 1,
  inline: 2,
  vendor: 3,
  unknown: 4,
};

// ----------------------------------------------------------
// QUEUE ITEM
// ----------------------------------------------------------

interface QueueItem {
  asset: AssetRecord;
  priority: number;
  /** Timestamp when this item was enqueued (used for FIFO within same priority) */
  enqueued_at: number;
}

// ----------------------------------------------------------
// PRIORITY DEDUP QUEUE
// ----------------------------------------------------------

export class AssetQueue {
  private items: QueueItem[] = [];
  private seenUrls = new Set<string>();
  private seenHashes = new Set<string>();
  private inFlightCount = 0;
  private ctx: PipelineContext;

  constructor(ctx: PipelineContext) {
    this.ctx = ctx;
  }

  /**
   * Attempt to enqueue an AssetRecord.
   * Silently drops it if the URL or content hash has already been seen,
   * or if the StateManager marks it as previously completed.
   * Returns true if the asset was accepted into the queue.
   */
  enqueue(asset: AssetRecord): boolean {
    const normalizedUrl = normalizeUrl(asset.url);

    // --- Deduplication Layer 1: URL ---
    if (this.seenUrls.has(normalizedUrl)) {
      this.ctx.logger.debug(`Queue: dropped (duplicate URL) ${normalizedUrl}`);
      return false;
    }

    // --- Deduplication Layer 2: Content Hash ---
    if (this.seenHashes.has(asset.content_hash)) {
      this.ctx.logger.debug(
        `Queue: dropped (duplicate content hash ${asset.content_hash}) ${normalizedUrl}`
      );
      return false;
    }

    // --- Deduplication Layer 3: State Manager (resumability) ---
    if (this.ctx.state.isHashProcessed(asset.content_hash)) {
      this.ctx.logger.info(
        `Queue: skipping previously completed asset ${normalizedUrl}`
      );
      return false;
    }

    this.seenUrls.add(normalizedUrl);
    this.seenHashes.add(asset.content_hash);

    const item: QueueItem = {
      asset,
      priority: ASSET_PRIORITY[asset.asset_type] ?? 4,
      enqueued_at: Date.now(),
    };

    this.insertSorted(item);
    this.ctx.logger.debug(
      `Queue: accepted [${asset.asset_type}] ${normalizedUrl} (queue size: ${this.items.length})`
    );
    return true;
  }

  /**
   * Dequeue the highest-priority item, respecting max_concurrent limit.
   * Returns null if the queue is empty OR all slots are in use.
   */
  dequeue(): AssetRecord | null {
    if (this.items.length === 0) return null;
    if (this.inFlightCount >= this.ctx.config.http.max_concurrent) {
      this.ctx.logger.debug(
        `Queue: concurrency limit reached (${this.inFlightCount}/${this.ctx.config.http.max_concurrent})`
      );
      return null;
    }

    const item = this.items.shift()!;
    this.inFlightCount++;
    this.ctx.state.setAssetStatus(item.asset.url, "fetching");
    return item.asset;
  }

  /**
   * Call this when an asset has finished ALL pipeline stages (success or failure).
   * Decrements the in-flight counter so the next asset can be dequeued.
   */
  markComplete(url: string): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    this.ctx.logger.debug(`Queue: slot freed (in-flight: ${this.inFlightCount})`);
  }

  get size(): number {
    return this.items.length;
  }

  get inFlight(): number {
    return this.inFlightCount;
  }

  /** True when nothing left to process and nothing currently in flight */
  get isDrained(): boolean {
    return this.items.length === 0 && this.inFlightCount === 0;
  }

  /**
   * Snapshot of current queue contents (for diagnostics/logging).
   * Returns a summary, not the full items.
   */
  inspect(): Array<{ url: string; priority: number; asset_type: AssetType }> {
    return this.items.map((i) => ({
      url: i.asset.url,
      priority: i.priority,
      asset_type: i.asset.asset_type,
    }));
  }

  // ----------------------------------------------------------
  // INTERNAL HELPERS
  // ----------------------------------------------------------

  /**
   * Binary-insert into the sorted array to maintain priority order.
   * Ties in priority are broken by enqueued_at (FIFO).
   */
  private insertSorted(item: QueueItem): void {
    let lo = 0;
    let hi = this.items.length;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const existing = this.items[mid];

      const cmp = comparePriority(item, existing);
      if (cmp < 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }

    this.items.splice(lo, 0, item);
  }
}

// ----------------------------------------------------------
// COMPARISON & NORMALIZATION UTILITIES
// ----------------------------------------------------------

/**
 * Returns negative if `a` should come BEFORE `b` (higher priority).
 */
function comparePriority(a: QueueItem, b: QueueItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  // Same priority → FIFO by enqueue time
  return a.enqueued_at - b.enqueued_at;
}

/**
 * Normalize a URL for deduplication:
 * - Strip URL fragments (#section)
 * - Remove trailing slashes
 * - Lowercase scheme and host
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Remove fragment
    u.hash = "";
    // Lowercase scheme + host
    return u.href.toLowerCase().replace(/\/$/, "");
  } catch {
    // Not a full URL — return as-is (handles relative paths passed in)
    return raw.replace(/#.*$/, "").toLowerCase().replace(/\/$/, "");
  }
}
