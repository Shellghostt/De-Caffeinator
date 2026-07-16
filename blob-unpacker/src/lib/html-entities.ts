// ============================================================
// HTML ENTITY DECODER (attribute-safe subset)
// ============================================================

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (full, body: string) => {
      if (body[0] === "#") {
        const isHex = body[1] === "x" || body[1] === "X";
        const num = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return full;
        try {
          return String.fromCodePoint(num);
        } catch {
          return full;
        }
      }
      return NAMED[body] ?? full;
    }
  );
}
