// ============================================================
// STAGE 5 — ENTROPY
// Shannon entropy calculation for secret classification.
// Real secrets (API keys, tokens) have high randomness.
// Filters out low-entropy false positives like "admin".
// ============================================================

export function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
