// ============================================================
// STAGE 5 — SECRET EXTRACTOR (Enhanced)
// Finds hardcoded credentials, API keys, tokens, service keys.
// Shannon entropy filtering prevents false-positive explosion.
//
// Categories:
//   - api_key:              Generic API keys
//   - bearer_token:         Bearer auth tokens
//   - jwt_secret:           JSON Web Tokens
//   - database_url:         Connection strings (Mongo, Postgres, etc.)
//   - private_key:          RSA/EC private key headers
//   - hardcoded_credential: password/secret assignments
//   - unknown_high_entropy: High-entropy strings not matching other patterns
//
// Covers third-party services:
//   AWS, Firebase, Stripe, GitHub, Slack, Twilio, SendGrid,
//   Algolia, Mapbox, Google, Azure, etc.
// ============================================================

import { DiscoveredSecret, SecretType } from "../../types/contracts";
import { shannonEntropy } from "./entropy";

interface SecretPattern {
  type: SecretType;
  re: RegExp;
  group: number; // capture group index for the secret value
  minLength?: number;
  minEntropy?: number; // override per-pattern
}

const PATTERNS: SecretPattern[] = [
  // ── Generic API keys ──────────────────────────────────────
  {
    type: "api_key",
    re: /(?:api[_-]?key|apikey|access[_-]?key|api[_-]?secret|app[_-]?key|app[_-]?secret)\s*[:=]\s*["'`]([A-Za-z0-9_\-]{16,128})["'`]/gi,
    group: 1,
  },

  // ── AWS ────────────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](AKIA[0-9A-Z]{16})["'`]/g, // AWS access key ID
    group: 1,
    minLength: 20,
  },
  {
    type: "api_key",
    re: /(?:aws[_-]?secret|secret[_-]?access[_-]?key)\s*[:=]\s*["'`]([A-Za-z0-9/+=]{40})["'`]/gi,
    group: 1,
    minLength: 40,
  },

  // ── Firebase ───────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](AIza[0-9A-Za-z_-]{35})["'`]/g, // Google/Firebase API key
    group: 1,
  },
  {
    type: "api_key",
    re: /(?:firebase|firebaseConfig)\s*[:=]\s*\{[^}]*apiKey\s*:\s*["'`]([^"'`]+)["'`]/gi,
    group: 1,
  },

  // ── Stripe ─────────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](sk_(?:live|test)_[0-9a-zA-Z]{24,99})["'`]/g,
    group: 1,
  },
  {
    type: "api_key",
    re: /["'`](pk_(?:live|test)_[0-9a-zA-Z]{24,99})["'`]/g,
    group: 1,
  },

  // ── GitHub ─────────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](gh[ps]_[A-Za-z0-9_]{36,})["'`]/g,
    group: 1,
  },
  {
    type: "api_key",
    re: /["'`](github_pat_[A-Za-z0-9_]{22,})["'`]/g,
    group: 1,
  },

  // ── Slack ──────────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](xox[bpors]-[0-9]{10,13}-[A-Za-z0-9-]+)["'`]/g,
    group: 1,
  },

  // ── Twilio / SendGrid ──────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,})["'`]/g,
    group: 1,
  },

  // ── Mapbox ─────────────────────────────────────────────────
  {
    type: "api_key",
    re: /["'`](pk\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["'`]/g,
    group: 1,
  },

  // ── Bearer tokens ──────────────────────────────────────────
  {
    type: "bearer_token",
    re: /["'`]Bearer\s+([A-Za-z0-9\-._~+/]+=*)["'`]/gi,
    group: 1,
  },
  {
    type: "bearer_token",
    re: /(?:authorization|auth[_-]?token)\s*[:=]\s*["'`](?:Bearer\s+)?([A-Za-z0-9\-._~+/]{20,}=*)["'`]/gi,
    group: 1,
  },

  // ── JWT (three base64url parts) ────────────────────────────
  {
    type: "jwt_secret",
    re: /["'`](eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})["'`]/g,
    group: 1,
  },

  // ── Database connection strings ────────────────────────────
  {
    type: "database_url",
    re: /["'`]((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|mssql):\/\/[^\s"'`]{8,})["'`]/gi,
    group: 1,
  },

  // ── Private key headers ────────────────────────────────────
  {
    type: "private_key",
    re: /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----)/g,
    group: 1,
    minEntropy: 0, // always flag
  },

  // ── Generic hardcoded credentials ──────────────────────────
  {
    type: "hardcoded_credential",
    re: /(?:password|passwd|pwd|secret|token|auth_token|client_secret|oauth_secret)\s*[:=]\s*["'`]([^"'`\s]{8,128})["'`]/gi,
    group: 1,
  },

  // ── OAuth client secrets ───────────────────────────────────
  {
    type: "hardcoded_credential",
    re: /(?:client[_-]?secret|consumer[_-]?secret)\s*[:=]\s*["'`]([A-Za-z0-9_\-]{16,128})["'`]/gi,
    group: 1,
  },
];

// Minimum value length — skip trivially short matches
const MIN_VALUE_LENGTH = 8;

// Clearly fake / placeholder values to skip
const FAKE_VALUES = new Set([
  "your_api_key", "YOUR_API_KEY", "xxxxxxxx", "placeholder",
  "changeme", "secret", "password", "12345678", "abcdefgh",
  "xxx", "test", "testing", "example", "sample", "demo",
  "REPLACE_ME", "INSERT_KEY_HERE", "your-api-key-here",
  "your_secret_here", "YOUR_SECRET", "redacted",
  "undefined", "null", "true", "false",
]);

// Patterns that indicate a variable reference, not a real secret
const VARIABLE_REF_RE = /^(?:process\.env\.|window\.|import\.meta\.|__)/;

export function extractSecrets(
  code: string,
  sourceFile: string,
  minEntropy: number
): DiscoveredSecret[] {
  const seen = new Set<string>();
  const results: DiscoveredSecret[] = [];
  const lines = code.split("\n");

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(code)) !== null) {
      const value = match[pattern.group];
      if (!value) continue;

      const effectiveMinLen = pattern.minLength ?? MIN_VALUE_LENGTH;
      if (value.length < effectiveMinLen) continue;
      if (FAKE_VALUES.has(value) || FAKE_VALUES.has(value.toLowerCase())) continue;
      if (VARIABLE_REF_RE.test(value)) continue;
      if (seen.has(value)) continue;

      const entropy = shannonEntropy(value);
      const effectiveMinEntropy = pattern.minEntropy ?? minEntropy;
      if (entropy < effectiveMinEntropy) continue;

      seen.add(value);
      const line = getLineNumber(code, match.index);
      results.push({
        type: pattern.type,
        value: maskSecret(value),
        entropy: parseFloat(entropy.toFixed(3)),
        context_snippet: getContext(lines, line),
        source_file: sourceFile,
        line,
      });
    }
  }

  // ── High-entropy standalone string scan ─────────────────────
  // Catch secrets that don't match specific patterns but have
  // suspiciously high entropy (random-looking strings)
  const HIGH_ENTROPY_RE = /["'`]([A-Za-z0-9+/=_\-]{32,128})["'`]/g;
  HIGH_ENTROPY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HIGH_ENTROPY_RE.exec(code)) !== null) {
    const value = match[1];
    if (seen.has(value)) continue;
    if (FAKE_VALUES.has(value)) continue;
    if (value.length < 32) continue;

    const entropy = shannonEntropy(value);
    if (entropy < 4.5) continue; // Very high threshold for generic strings

    // Check context for secret-like assignments
    const line = getLineNumber(code, match.index);
    const context = getContext(lines, line);
    if (!/(?:key|secret|token|password|credential|auth|api)/i.test(context)) continue;

    seen.add(value);
    results.push({
      type: "unknown_high_entropy",
      value: maskSecret(value),
      entropy: parseFloat(entropy.toFixed(3)),
      context_snippet: context,
      source_file: sourceFile,
      line,
    });
  }

  return results;
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

/**
 * Mask a secret for safe output — show first 4 and last 4 chars.
 * This prevents the pipeline's own output from being a security risk.
 */
function maskSecret(value: string): string {
  if (value.length <= 12) return value.slice(0, 3) + "***" + value.slice(-3);
  return value.slice(0, 4) + "..." + value.slice(-4) + ` [${value.length} chars]`;
}

function getLineNumber(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

function getContext(lines: string[], lineNum: number): string {
  const start = Math.max(0, lineNum - 2);
  const end = Math.min(lines.length - 1, lineNum + 1);
  return lines.slice(start, end + 1).join("\n");
}
