// ============================================================
// STAGE 4 — STRING ARRAY RESOLVER
// Handles the most common JS obfuscation pattern:
// All strings are moved to a rotated array and replaced with
// lookup calls like _0x1a2b[42] or _0xabc('0x1f', 'key').
// Builds a lookup table and substitutes real strings back.
// ============================================================

export interface StringArrayResult {
  resolved: boolean;
  code: string;
  substitutionCount: number;
}

// Detects a top-level string array declaration
// e.g. var _0x1a2b = ["str1","str2",...];
const ARRAY_DECL_RE =
  /(?:var|let|const)\s+(_0x[a-f0-9]+)\s*=\s*(\[(?:"[^"]*"|'[^']*'|,|\s)+\])/;

// Detects a rotation call (self-invoking that rotates the array)
const ROTATION_RE = /\(function\s*\(\w+,\s*\w+\)\s*\{[\s\S]{0,500}\.push\(/;

export function resolveStringArray(code: string): StringArrayResult {
  const arrayMatch = ARRAY_DECL_RE.exec(code);
  if (!arrayMatch) return { resolved: false, code, substitutionCount: 0 };

  const arrayName = arrayMatch[1];
  let stringArray: string[];

  try {
    stringArray = JSON.parse(arrayMatch[2].replace(/'/g, '"'));
  } catch {
    return { resolved: false, code, substitutionCount: 0 };
  }

  if (stringArray.length < 5) {
    // Too small to be an obfuscation array
    return { resolved: false, code, substitutionCount: 0 };
  }

  // Apply rotation if detected
  if (ROTATION_RE.test(code)) {
    stringArray = applyRotation(code, arrayName, stringArray);
  }

  // Build lookup table for both numeric and hex indices
  const lookup = new Map<string, string>(
    stringArray.map((val, i) => [String(i), val])
  );

  // Replace all array accesses: _0x1a2b[0] → "actual string"
  const numericAccess = new RegExp(
    `\\b${escapeRegex(arrayName)}\\s*\\[\\s*(\\d+)\\s*\\]`,
    "g"
  );

  let substitutionCount = 0;
  const result = code.replace(numericAccess, (_, idx) => {
    const val = lookup.get(idx);
    if (val !== undefined) {
      substitutionCount++;
      return JSON.stringify(val);
    }
    return _;
  });

  return {
    resolved: substitutionCount > 0,
    code: result,
    substitutionCount,
  };
}

function applyRotation(
  code: string,
  arrayName: string,
  arr: string[]
): string[] {
  // Attempt to extract the rotation offset from the code
  // Pattern: parseInt(_0x1a2b[0], 16) === <target>
  const offsetMatch = /parseInt\s*\([^,]+,\s*16\s*\)\s*===?\s*(-?\d+)/.exec(code);
  if (!offsetMatch) return arr;

  const target = parseInt(offsetMatch[1], 10);
  const rotated = [...arr];

  // Rotate until the checksum matches (max 500 attempts)
  for (let i = 0; i < 500; i++) {
    const check = parseInt(rotated[0], 16);
    if (check === target) return rotated;
    rotated.push(rotated.shift()!);
  }

  return arr; // rotation didn't converge — return original
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
