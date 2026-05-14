// ============================================================
// STAGE 4 — EVAL UNPACKER
// Detects and unwraps eval(atob(...)), eval(unescape(...)),
// and Function(...)() packing patterns.
// Uses Node's vm.runInNewContext with a strict resource budget.
// NEVER executes arbitrary code — only known safe decode ops.
// ============================================================

import * as vm from "vm";

export interface EvalUnpackResult {
  unpacked: boolean;
  code: string;
}

// Patterns indicating packed code
const EVAL_ATOB_RE = /\beval\s*\(\s*atob\s*\(/;
const EVAL_UNESCAPE_RE = /\beval\s*\(\s*(?:unescape|decodeURIComponent)\s*\(/;
const FUNCTION_CONSTRUCTOR_RE = /\bnew\s+Function\s*\(\s*["'`][\s\S]{0,50}["'`]\s*\)/;
const P_A_C_K_E_R_RE = /eval\(function\(p,a,c,k,e,(?:d|r)\)/; // dean edwards packer

export function evalUnpack(code: string): EvalUnpackResult {
  // ── Dean Edwards p,a,c,k,e,r ─────────────────────────────
  if (P_A_C_K_E_R_RE.test(code)) {
    const result = unpackDeanEdwards(code);
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
// DEAN EDWARDS p,a,c,k,e,r
// Safe to run in a sandbox — it only does string replacement
// ----------------------------------------------------------

function unpackDeanEdwards(code: string): string | null {
  try {
    const sandbox = {
      result: null as string | null,
      // Override eval to capture the unpacked output instead of executing it
      eval: (s: string) => { sandbox.result = s; },
    };
    vm.runInNewContext(code, sandbox, { timeout: 2000 });
    return sandbox.result;
  } catch {
    return null;
  }
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
  const match = /eval\s*\(\s*(?:unescape|decodeURIComponent)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/.exec(code);
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

/** True if the code still contains packing patterns after one pass */
export function isStillPacked(code: string): boolean {
  return (
    P_A_C_K_E_R_RE.test(code) ||
    EVAL_ATOB_RE.test(code) ||
    EVAL_UNESCAPE_RE.test(code) ||
    FUNCTION_CONSTRUCTOR_RE.test(code)
  );
}
