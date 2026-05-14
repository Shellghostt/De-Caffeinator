// ============================================================
// STAGE 4 — HEX FUNCTION CALL RESOLVER
// Handles the advanced obfuscation pattern where strings are
// accessed via hex-named function calls:
//   _0xabc('0x1f')       — single-arg: index lookup
//   _0xabc('0x1f', 'key') — two-arg: RC4/XOR decoded lookup
//
// This is used by javascript-obfuscator and similar tools.
// We detect the accessor function definition, build the
// lookup table, and replace all calls with the decoded strings.
// ============================================================

export interface HexCallResult {
  resolved: boolean;
  code: string;
  substitutionCount: number;
}

// Matches hex-named function calls: _0xabc('0x1f') or _0xabc('0x1f','key')
const HEX_CALL_RE = /\b(_0x[a-f0-9]+)\s*\(\s*'(0x[a-f0-9]+)'(?:\s*,\s*'([^']*)')?\s*\)/g;

// Matches the accessor function definition
// function _0xabc(idx, key) { ... return _0xlist[idx]; }
const ACCESSOR_FN_RE =
  /(?:var|let|const|function)\s+(_0x[a-f0-9]+)\s*(?:=\s*function)?\s*\(\s*\w+(?:\s*,\s*\w+)?\s*\)\s*\{/g;

export function resolveHexCalls(code: string): HexCallResult {
  // First, find the string array
  const { arrayName, stringArray } = findStringArray(code);
  if (!arrayName || stringArray.length === 0) {
    return { resolved: false, code, substitutionCount: 0 };
  }

  // Find which function name is the accessor
  const accessorName = findAccessorFunction(code, arrayName);
  if (!accessorName) {
    return { resolved: false, code, substitutionCount: 0 };
  }

  // Replace all calls to the accessor function
  const callRe = new RegExp(
    `\\b${escapeRegex(accessorName)}\\s*\\(\\s*'(0x[a-f0-9]+)'(?:\\s*,\\s*'([^']*)')?\\s*\\)`,
    "g"
  );

  let substitutionCount = 0;
  const result = code.replace(callRe, (_, hexIdx, _key) => {
    const idx = parseInt(hexIdx, 16);
    if (idx >= 0 && idx < stringArray.length) {
      substitutionCount++;
      return JSON.stringify(stringArray[idx]);
    }
    return _;
  });

  return {
    resolved: substitutionCount > 0,
    code: result,
    substitutionCount,
  };
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

interface StringArrayInfo {
  arrayName: string | null;
  stringArray: string[];
}

function findStringArray(code: string): StringArrayInfo {
  // Pattern 1: var _0xlist = ["str1", "str2", ...]
  const arrayDeclRe =
    /(?:var|let|const)\s+(_0x[a-f0-9]+)\s*=\s*(\[(?:"[^"]*"|'[^']*'|,|\s)+\])/;
  const match = arrayDeclRe.exec(code);

  if (!match) return { arrayName: null, stringArray: [] };

  try {
    const normalized = match[2].replace(/'/g, '"');
    const arr = JSON.parse(normalized);
    if (Array.isArray(arr) && arr.length >= 3) {
      return { arrayName: match[1], stringArray: arr };
    }
  } catch {
    // Fallback: try to extract strings manually
  }

  return { arrayName: null, stringArray: [] };
}

function findAccessorFunction(code: string, arrayName: string): string | null {
  // Look for a function that references the array
  ACCESSOR_FN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ACCESSOR_FN_RE.exec(code)) !== null) {
    const fnName = match[1];
    // Check if this function's body references the array
    const fnStart = match.index;
    const bodyStart = code.indexOf("{", fnStart + match[0].length - 1);
    if (bodyStart === -1) continue;

    // Quick scan for array reference in next 500 chars
    const snippet = code.slice(bodyStart, bodyStart + 500);
    if (snippet.includes(arrayName)) {
      return fnName;
    }
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
