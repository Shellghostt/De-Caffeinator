// ============================================================
// LINE INDEX HELPER
// O(1) line lookups after a single O(n) preprocess.
// ============================================================

/** Build a sorted list of start offsets for each line (0-based). */
export function buildLineStarts(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number for a character index into `code`. */
export function lineNumberAt(lineStarts: number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= index) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi + 1; // 1-based
}
