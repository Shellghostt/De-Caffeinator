// ============================================================
// STAGE 5 — COMMENT EXTRACTOR (Enhanced)
// Extracts developer comments that signal security-relevant
// information: TODOs, FIXMEs, auth bypasses, debug notes,
// vulnerability mentions, permission issues, and general notes.
//
// Categories:
//   todo   — TODO items left by developers
//   fixme  — Known broken/dangerous code
//   hack   — Workarounds and hacks
//   bypass — Auth/security bypass indicators
//   debug  — Debug code left in production
//   note   — General developer notes with useful context
// ============================================================

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

// Matches single-line and inline comments
const SINGLE_LINE_RE = /\/\/(.+)/g;
// Matches block comments
const BLOCK_RE = /\/\*([\s\S]*?)\*\//g;

export function extractComments(
  code: string,
  sourceFile: string
): DiscoveredComment[] {
  const results: DiscoveredComment[] = [];
  const seen = new Set<string>();

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

  let match: RegExpExecArray | null;

  SINGLE_LINE_RE.lastIndex = 0;
  while ((match = SINGLE_LINE_RE.exec(code)) !== null) {
    check(match[1], getLineNumber(code, match.index));
  }

  BLOCK_RE.lastIndex = 0;
  while ((match = BLOCK_RE.exec(code)) !== null) {
    // Split block into lines and check each
    const blockLines = match[1].split("\n");
    const startLine = getLineNumber(code, match.index);
    blockLines.forEach((l, i) => check(l, startLine + i));
  }

  return results;
}

function getLineNumber(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}
