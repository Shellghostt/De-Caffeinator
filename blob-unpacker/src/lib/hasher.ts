// ============================================================
// BLOB UNPACKER — CONTENT HASHER
// ============================================================

import * as crypto from "crypto";

/** Soft cap — hashing multi-GB strings is a DoS vector */
const MAX_HASH_CHARS = 50 * 1024 * 1024;

export function sha256(content: string): string {
  const input =
    content.length > MAX_HASH_CHARS ? content.slice(0, MAX_HASH_CHARS) : content;
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}
