// ============================================================
// STAGE 4 — EVAL UNPACKER
// Detects and unwraps eval(atob(...)), eval(unescape(...)),
// Function(...)(), and Dean Edwards packer patterns.
// Uses STATIC decoding only — never executes untrusted code.
// ============================================================

export interface EvalUnpackResult {
  unpacked: boolean;
  code: string;
}

export interface EvalUnpackOptions {
  /**
   * When false, skip all unpack paths that involve packed loaders.
   * Static string unwraps (atob / unescape / Function body extract) still run.
   * Default: true (static Dean Edwards unpack allowed).
   */
  evalSandbox?: boolean;
}

// Patterns indicating packed code
const EVAL_ATOB_RE = /\beval\s*\(\s*atob\s*\(/;
const EVAL_UNESCAPE_RE = /\beval\s*\(\s*(?:unescape|decodeURIComponent)\s*\(/;
const FUNCTION_CONSTRUCTOR_RE = /\bnew\s+Function\s*\(\s*["'`][\s\S]{0,50}["'`]\s*\)/;
const P_A_C_K_E_R_RE = /eval\(function\(p,a,c,k,e,(?:d|r)\)/; // dean edwards packer

export function evalUnpack(
  code: string,
  options: EvalUnpackOptions = {}
): EvalUnpackResult {
  const allowPacker = options.evalSandbox !== false;

  // ── Dean Edwards p,a,c,k,e,r (static only — never vm) ────
  if (allowPacker && P_A_C_K_E_R_RE.test(code)) {
    const result = unpackDeanEdwardsStatic(code);
    if (result) return { unpacked: true, code: result };
  }

  // ── eval(atob(...)) ───────────────────────────────────────
  if (EVAL_ATOB_RE.test(code)) {
    const result = unwrapEvalAtob(code);
    if (result) return { unpacked: true, code: result };
  }

  // ── eval(unescape(...)) ───────────────────────────────────
  if (EVAL_UNESCAPE_RE.test(code)) {
    const result = unwrapEvalUnescape(code);
    if (result) return { unpacked: true, code: result };
  }

  // ── new Function(...) ─────────────────────────────────────
  if (FUNCTION_CONSTRUCTOR_RE.test(code)) {
    const result = unwrapFunctionConstructor(code);
    if (result) return { unpacked: true, code: result };
  }

  return { unpacked: false, code };
}

// ----------------------------------------------------------
// DEAN EDWARDS p,a,c,k,e,r — static unpack (no code execution)
// Extracts payload + dictionary from the packer call site and
// performs the standard base-N token substitution in plain JS.
// ----------------------------------------------------------

function unpackDeanEdwardsStatic(code: string): string | null {
  // Common call form:
  //   }('payload',62,count,'w0|w1|...'.split('|'),0,{}))
  // Quotes may be ' or "
  const callRe =
    /}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\s*\(\s*(['"])\|?\7\s*\)/;
  const m = callRe.exec(code);
  if (!m) return null;

  try {
    const payload = unescapePackerString(m[2]);
    const radix = parseInt(m[3], 10);
    let count = parseInt(m[4], 10);
    const dictionary = m[6].split("|");

    if (!Number.isFinite(radix) || radix < 2 || radix > 95) return null;
    if (!Number.isFinite(count) || count < 0 || count > 500_000) return null;
    if (dictionary.length === 0) return null;

    return substitutePacker(payload, radix, count, dictionary);
  } catch {
    return null;
  }
}

function unescapePackerString(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function packerEncode(c: number, radix: number): string {
  return (
    (c < radix ? "" : packerEncode(Math.floor(c / radix), radix)) +
    ((c %= radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36))
  );
}

function substitutePacker(
  payload: string,
  radix: number,
  count: number,
  dictionary: string[]
): string {
  let p = payload;
  let c = count;

  while (c--) {
    const token = packerEncode(c, radix);
    const replacement = dictionary[c];
    if (!replacement) continue;
    // Escape regex metacharacters in the token
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    p = p.replace(new RegExp("\\b" + escaped + "\\b", "g"), replacement);
  }

  return p;
}

// ----------------------------------------------------------
// eval(atob("base64..."))
// Extract the base64 string and decode it statically — no eval
// ----------------------------------------------------------

function unwrapEvalAtob(code: string): string | null {
  const match = /eval\s*\(\s*atob\s*\(\s*["'`]([A-Za-z0-9+/=]+)["'`]\s*\)/.exec(code);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// ----------------------------------------------------------
// eval(unescape("%xx%xx..."))
// ----------------------------------------------------------

function unwrapEvalUnescape(code: string): string | null {
  const match =
    /eval\s*\(\s*(?:unescape|decodeURIComponent)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/.exec(code);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1].replace(/%(?![\dA-Fa-f]{2})/g, "%25"));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------
// new Function("return ...")()
// Only handle the case where the inner string is a literal
// ----------------------------------------------------------

function unwrapFunctionConstructor(code: string): string | null {
  const match = /new\s+Function\s*\(\s*["'`]([\s\S]+?)["'`]\s*\)\s*\(\s*\)/.exec(code);
  if (!match) return null;
  // Return the body string — don't execute it
  return match[1];
}

/**
 * True if the code still contains EXPLICIT obfuscation patterns after one pass.
 *
 * Only triggers on patterns that indicate deliberate code packing/obfuscation:
 *   1. Dean Edwards p,a,c,k,e,r  — eval(function(p,a,c,k,e,d){...})
 *   2. Obfuscator.io hex arrays   — large _0x variable arrays used for string hiding
 *
 * Standard minified variable names (e, t, n, r, ...) and legitimate uses of
 * `new Function(...)`, `eval(atob(...))` etc. in framework code do NOT trigger this.
 * This prevents minified-but-not-obfuscated libraries (Angular, React, jQuery)
 * from causing infinite Stage 4 recursion loops.
 */
export function isStillPacked(code: string): boolean {
  // Pattern 1: Dean Edwards packer — eval(function(p,a,c,k,e,d){...})
  if (P_A_C_K_E_R_RE.test(code)) return true;

  // Pattern 2: Obfuscator.io-style hex string arrays with multiple entries
  // Require at least a few quoted strings in the array to reduce false positives
  const HEX_ARRAY_RE =
    /\b_0x[0-9a-f]{2,6}\s*=\s*\[\s*(?:['"`][^'"`]*['"`]\s*,\s*){2,}['"`]/i;
  if (HEX_ARRAY_RE.test(code)) return true;

  return false;
}
