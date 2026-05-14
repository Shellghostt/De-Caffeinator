// ============================================================
// BLOB UNPACKER — HASHER
// SHA-256 content hashing for deduplication.
// ============================================================

import * as crypto from "crypto";

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}
