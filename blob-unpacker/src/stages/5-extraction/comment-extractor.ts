// ============================================================
// STAGE 5 — COMMENT EXTRACTOR (AST-powered)
// Extracts developer comments that signal security-relevant
// information: TODOs, FIXMEs, auth bypasses, debug notes,
// vulnerability mentions, permission issues, and general notes.
//
// Uses Acorn's onComment callback to capture ONLY actual
// JavaScript comments (CommentLine and CommentBlock AST nodes).
// This avoids false positives from regex matching minified code
// lines that happen to contain "//" in URLs or string literals.
//
// Categories:
//   todo   — TODO items left by developers
//   fixme  — Known broken/dangerous code
//   hack   — Workarounds and hacks
//   bypass — Auth/security bypass indicators
//   debug  — Debug code left in production
//   note   — General developer notes with useful context
// ============================================================

import * as acorn from "acorn";
import { DiscoveredComment, CommentCategory } from "../../types/contracts";

interface CommentRule {
  category: CommentCategory;
  re: RegExp;
  priority: number; // lower = higher priority (used for multi-match tie-breaking)
}

const RULES: CommentRule[] = [
  // ── Security-critical (highest priority) ────────────────────
  {
    category: "bypass",
    re: /\bbypass\b|\bskip.{0,10}auth\b|\bno.{0,5}auth\b|\bdisable.{0,10}check\b|\bdisable.{0,10}security\b|\bdisable.{0,10}csrf\b|\bdisable.{0,10}cors\b|\bforce.{0,10}allow\b|\ballow.{0,10}all\b|\binsecure\b|\bvulnerab/i,
    priority: 1,
  },

  // ── Debug code left in production ───────────────────────────
  {
    category: "debug",
    re: /\bremove.{0,15}before.{0,15}prod\b|\bremove.{0,15}in.{0,10}prod\b|\btmp\b|\btemp(?:orary)?\b|\bdebug\s*mode\b|\bdebug.{0,10}only\b|\bfor.{0,10}testing.{0,10}only\b|\bshould.{0,10}not.{0,10}be.{0,10}here\b|\bdelete.{0,10}this\b|\bdo.{0,5}not.{0,10}commit\b|\bdo.{0,5}not.{0,10}deploy\b/i,
    priority: 2,
  },

  // ── Hacks & workarounds ─────────────────────────────────────
  {
    category: "hack",
    re: /\bHACK\b|\bWORKAROUND\b|\bKLUDGE\b|\bGROSS\b|\bUGLY\b|\bNASTY\b|\bmonkeypatch\b|\bdirty.{0,5}fix\b/i,
    priority: 3,
  },

  // ── Known issues ────────────────────────────────────────────
  {
    category: "fixme",
    re: /\bFIXME\b|\bBUG\b|\bBROKEN\b|\bFAILS?\b|\bWONT.{0,5}WORK\b|\bDOESN'?T.{0,5}WORK\b|\bXXX\b|\bDANGEROUS\b|\bWARNING\b|\bCAUTION\b|\bDEPRECATED\b|\bUNSAFE\b/i,
    priority: 4,
  },

  // ── TODO items ──────────────────────────────────────────────
  {
    category: "todo",
    re: /\bTODO\b|\bTO[\s-]?DO\b|\bNEED.{0,5}TO\b|\bSHOULD\b|\bPLEASE\b|\bREFACTOR\b|\bCLEANUP\b|\bOPTIMIZE\b/i,
    priority: 5,
  },

  // ── General notes with useful info ──────────────────────────
  {
    category: "note",
    re: /\bNOTE\b|\bIMPORTANT\b|\bATTENTION\b|\bBEWARE\b|\bCAVEAT\b|\bGOTCHA\b|\bREMINDER\b|\bSEE\s+ALSO\b|\bN\.?B\.?\b/i,
    priority: 6,
  },
];

// ── Security-specific keyword boosters ───────────────────────
// If a comment mentions these, always capture it even without a category keyword
const SECURITY_KEYWORDS =
  /\b(?:auth(?:entication|orization)?|permission|credential|token|secret|password|encrypt|decrypt|hash|salt|session|cookie|csrf|xss|injection|privilege|escalat|sanitiz|validat|whitelist|blacklist|allowlist|denylist|firewall|ssl|tls|certificate|cors|origin|header|vulnerability|exploit|attack|threat|breach|leak|expos)/i;

/** Raw comment as captured by Acorn's onComment callback */
interface AcornComment {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

export function extractComments(
  code: string,
  sourceFile: string
): DiscoveredComment[] {
  const results: DiscoveredComment[] = [];
  const seen = new Set<string>();

  // ── Collect comments via Acorn AST parser ──────────────────
  // This guarantees we only get actual JS comments (CommentLine
  // and CommentBlock), NOT code statements or object properties.
  const comments: AcornComment[] = [];

  try {
    acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: "module",
      allowHashBang: true,
      locations: true,
      onComment: comments as any,
    });
  } catch {
    // Module mode failed — try script mode
    comments.length = 0;
    try {
      acorn.parse(code, {
        ecmaVersion: 2022,
        sourceType: "script",
        allowHashBang: true,
        locations: true,
        onComment: comments as any,
      });
    } catch {
      // Parse failed entirely — return empty rather than falling back to regex
      // which would produce the false positives we're trying to avoid
      return results;
    }
  }

  // ── Classify each genuine comment ──────────────────────────
  const check = (text: string, line: number) => {
    const trimmed = text.trim()
      .replace(/^\*\s*/, "") // strip leading * from block comments
      .replace(/^\/\/\s*/, ""); // strip leading //

    if (trimmed.length < 5 || seen.has(trimmed)) return;

    // Check against category rules (in priority order)
    const sortedRules = [...RULES].sort((a, b) => a.priority - b.priority);
    for (const { category, re } of sortedRules) {
      if (re.test(trimmed)) {
        seen.add(trimmed);
        results.push({ text: trimmed, category, source_file: sourceFile, line });
        return; // one category per comment
      }
    }

    // Security keyword fallback — capture as "note" if security-relevant
    if (SECURITY_KEYWORDS.test(trimmed) && trimmed.length >= 15) {
      seen.add(trimmed);
      results.push({ text: trimmed, category: "note", source_file: sourceFile, line });
    }
  };

  for (const comment of comments) {
    const line = comment.loc?.start?.line ?? 1;

    if (comment.type === "Line") {
      // Single-line comment: // ...
      check(comment.value, line);
    } else if (comment.type === "Block") {
      // Block comment: /* ... */ — check each line separately
      const blockLines = comment.value.split("\n");
      blockLines.forEach((l, i) => check(l, line + i));
    }
  }

  return results;
}
