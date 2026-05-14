// ============================================================
// STAGE 4 — CONSTANT FOLDER
// Resolves static encodings that obscure readable strings:
//   - Hex escapes:     \x68\x65\x6c\x6c\x6f → "hello"
//   - Unicode escapes: \u0068\u0065\u006c    → "hel"
//   - String concat:   "htt" + "ps://"       → "https://"
//   - fromCharCode:    String.fromCharCode(72,101) → "He"
// ============================================================

export function foldConstants(code: string): string {
  let result = code;

  // ── Hex escape sequences in string literals ───────────────
  result = result.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g,
    (str) => {
      try {
        // Let JSON.parse decode escape sequences
        const inner = str.slice(1, -1);
        const decoded = inner
          .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
            String.fromCharCode(parseInt(h, 16))
          )
          .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
            String.fromCharCode(parseInt(h, 16))
          );
        // Only replace if something changed
        return decoded !== inner ? str[0] + decoded + str[str.length - 1] : str;
      } catch {
        return str;
      }
    }
  );

  // ── String concatenation of literals ─────────────────────
  // "htt" + "ps://" → "https://"
  let prev = "";
  while (prev !== result) {
    prev = result;
    result = result.replace(
      /("(?:[^"\\]|\\.)*")\s*\+\s*("(?:[^"\\]|\\.)*")/g,
      (_, a, b) => {
        try {
          return JSON.stringify(JSON.parse(a) + JSON.parse(b));
        } catch {
          return _;
        }
      }
    );
  }

  // ── String.fromCharCode(...) ──────────────────────────────
  result = result.replace(
    /String\.fromCharCode\s*\(([^)]+)\)/g,
    (_, args) => {
      try {
        const codes = args
          .split(",")
          .map((s: string) => parseInt(s.trim(), 10));
        if (codes.some(isNaN)) return _;
        return JSON.stringify(String.fromCharCode(...codes));
      } catch {
        return _;
      }
    }
  );

  return result;
}
