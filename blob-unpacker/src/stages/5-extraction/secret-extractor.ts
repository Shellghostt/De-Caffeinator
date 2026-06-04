// ============================================================
// STAGE 5 — SECRET EXTRACTOR (Enhanced + Filtered)
// Finds hardcoded credentials, API keys, tokens, service keys.
// Shannon entropy filtering prevents false-positive explosion.
//
// FALSE POSITIVE FILTERS (3-layer noise reduction):
//   1. Known Alphabets — Base64 charset, hex charset, etc.
//   2. Context Variables — _keyStr, alphabet, chars, encoding
//   3. Known Prefixes  — sk_live_, AKIA, ghp_, etc. (boosted)
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
    re: /(?:api[_-]?key|apikey|access[_-]?key|api[_-]?secret|app[_-]?key|app[_-]?secret)\s*[:=]\s*["'`]([A-Za-z0-9_-]{16,128})["'`]/gi,
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
    re: /(?:client[_-]?secret|consumer[_-]?secret)\s*[:=]\s*["'`]([A-Za-z0-9_-]{16,128})["'`]/gi,
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

// ============================================================
// FALSE POSITIVE FILTER 1: Known Encoding Alphabets
// Base64, hex, and other charset strings have extremely high
// entropy but are never real secrets.
// ============================================================
const KNOWN_ALPHABETS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "0123456789abcdef",
  "0123456789ABCDEF",
  "0123456789abcdefABCDEF",
  "abcdefghijklmnopqrstuvwxyz",
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
];
const KNOWN_ALPHABET_SET = new Set(KNOWN_ALPHABETS);

// Also catch Base64 alphabets that are reordered or slightly varied
const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/=_-]{64,66}$/;
function isEncodingAlphabet(value: string): boolean {
  if (KNOWN_ALPHABET_SET.has(value)) return true;
  // A string that is 64-66 chars and contains ALL of A-Z, a-z, 0-9
  // is almost certainly a charset definition, not a secret
  if (BASE64_ALPHABET_RE.test(value)) {
    const hasUpper = /[A-Z]/.test(value);
    const hasLower = /[a-z]/.test(value);
    const hasDigit = /[0-9]/.test(value);
    const uniqueChars = new Set(value).size;
    if (hasUpper && hasLower && hasDigit && uniqueChars >= 62) return true;
  }
  return false;
}

// ============================================================
// FALSE POSITIVE FILTER 2: Contextual Variable Name Filter
// If the surrounding code assigns the high-entropy string to
// a variable named "_keyStr", "alphabet", "chars", etc., it's
// an encoding definition, not a leaked credential.
// ============================================================
const ENCODING_CONTEXT_NAMES = [
  "_keyStr", "keyStr", "alphabet", "ALPHABET", "chars", "CHARS",
  "b64", "b64chars", "base64", "BASE64", "base64chars", "base64Chars",
  "encoding", "ENCODING", "charset", "CHARSET", "charSet",
  "digits", "DIGITS", "hexChars", "hexDigits", "lookup",
  "toBase64", "fromBase64", "encodeChars", "decodeChars",
  "urlSafe", "urlSafeBase64", "intToChar", "charToInt",
];
function isEncodingContext(contextSnippet: string): boolean {
  return ENCODING_CONTEXT_NAMES.some((name) => contextSnippet.includes(name));
}

// ============================================================
// FALSE POSITIVE FILTER 3: Known Secret Prefixes (Booster)
// Real API keys from major services have recognizable prefixes.
// These get flagged as HIGH confidence regardless of entropy.
// ============================================================
interface KnownPrefix {
  prefix: string;
  service: string;
  type: SecretType;
}
const KNOWN_PREFIXES: KnownPrefix[] = [
  { prefix: "sk_live_",     service: "Stripe (live)",     type: "api_key" },
  { prefix: "sk_test_",     service: "Stripe (test)",     type: "api_key" },
  { prefix: "pk_live_",     service: "Stripe (live pub)", type: "api_key" },
  { prefix: "pk_test_",     service: "Stripe (test pub)", type: "api_key" },
  { prefix: "AKIA",         service: "AWS Access Key",    type: "api_key" },
  { prefix: "ghp_",         service: "GitHub PAT",        type: "api_key" },
  { prefix: "ghs_",         service: "GitHub App",        type: "api_key" },
  { prefix: "gho_",         service: "GitHub OAuth",      type: "api_key" },
  { prefix: "github_pat_",  service: "GitHub Fine-grained", type: "api_key" },
  { prefix: "glpat-",       service: "GitLab PAT",        type: "api_key" },
  { prefix: "xox",          service: "Slack",             type: "api_key" },
  { prefix: "SG.",          service: "SendGrid",          type: "api_key" },
  { prefix: "AIza",         service: "Google/Firebase",   type: "api_key" },
  { prefix: "pk.eyJ",       service: "Mapbox",            type: "api_key" },
  { prefix: "sk.eyJ",       service: "Mapbox (secret)",   type: "api_key" },
  { prefix: "eyJ",          service: "JWT",               type: "jwt_secret" },
  { prefix: "shpat_",       service: "Shopify",           type: "api_key" },
  { prefix: "shpss_",       service: "Shopify Shared",    type: "api_key" },
  { prefix: "AC",           service: "Twilio",            type: "api_key" },
  { prefix: "npm_",         service: "npm",               type: "api_key" },
  { prefix: "pypi-",        service: "PyPI",              type: "api_key" },
  { prefix: "sq0csp-",      service: "Square",            type: "api_key" },
  { prefix: "sqOatp-",      service: "Square OAuth",      type: "api_key" },
  { prefix: "hf_",          service: "Hugging Face",      type: "api_key" },
];

function matchKnownPrefix(value: string): KnownPrefix | null {
  for (const kp of KNOWN_PREFIXES) {
    if (value.startsWith(kp.prefix)) return kp;
  }
  return null;
}

// ============================================================
// MASTER FALSE-POSITIVE CHECK
// Runs all three filters on every candidate.
// Returns true if the value should be SKIPPED.
// ============================================================
function isFalsePositive(value: string, contextSnippet: string): boolean {
  // Filter 1: Known encoding alphabets
  if (isEncodingAlphabet(value)) return true;

  // Filter 2: Encoding-related variable names in context
  if (isEncodingContext(contextSnippet)) return true;

  // Common library constants (hashes, charset tables)
  if (/^[0-9a-f]{32,64}$/i.test(value)) {
    // Looks like an MD5/SHA hash — only flag if context mentions secret/key
    if (!/(?:key|secret|token|password|credential|auth)/i.test(contextSnippet)) {
      return true;
    }
  }

  return false;
}

export function extractSecrets(
  code: string,
  sourceFile: string,
  minEntropy: number
): DiscoveredSecret[] {
  const seen = new Set<string>();
  const results: DiscoveredSecret[] = [];
  const lines = code.split("\n");

  // ── Pass 1: Known-prefix scan (highest confidence) ─────────
  // Scan the entire code for strings matching known service prefixes.
  // These bypass entropy checks entirely — the prefix IS the signal.
  const PREFIX_SCAN_RE = /["'`]([A-Za-z0-9_\-./+=]{16,256})["'`]/g;
  PREFIX_SCAN_RE.lastIndex = 0;
  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = PREFIX_SCAN_RE.exec(code)) !== null) {
    const value = prefixMatch[1];
    if (seen.has(value)) continue;

    const kp = matchKnownPrefix(value);
    if (!kp) continue;

    const line = getLineNumber(code, prefixMatch.index);
    const context = getContext(lines, line);

    // Even known-prefix matches can be false positives in context
    if (isFalsePositive(value, context)) continue;

    seen.add(value);
    results.push({
      type: kp.type,
      value: maskSecret(value),
      entropy: parseFloat(shannonEntropy(value).toFixed(3)),
      context_snippet: context,
      source_file: sourceFile,
      line,
    });
  }

  // ── Pass 2: Pattern-based extraction ───────────────────────
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

      const line = getLineNumber(code, match.index);
      const context = getContext(lines, line);

      // ── Apply false-positive filters ──────────────────────
      if (isFalsePositive(value, context)) continue;

      seen.add(value);
      results.push({
        type: pattern.type,
        value: maskSecret(value),
        entropy: parseFloat(entropy.toFixed(3)),
        context_snippet: context,
        source_file: sourceFile,
        line,
      });
    }
  }

  // ── Pass 3: High-entropy standalone string scan ────────────
  // Catch secrets that don't match specific patterns but have
  // suspiciously high entropy (random-looking strings)
  const HIGH_ENTROPY_RE = /["'`]([A-Za-z0-9+/=_-]{32,128})["'`]/g;
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

    // ── Apply false-positive filters ──────────────────────
    if (isFalsePositive(value, context)) continue;

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
