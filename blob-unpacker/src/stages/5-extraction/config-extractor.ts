// ============================================================
// STAGE 5 — CONFIG EXTRACTOR (Enhanced)
// Finds configuration objects, environment variables,
// feature flags, and third-party service integrations.
//
// Covers:
//   - process.env.* / import.meta.env.* / window.__*__
//   - Config/settings object literals
//   - Feature flags (boolean key patterns)
//   - Third-party service configs:
//       Firebase, Sentry, Stripe, Auth0, Algolia, AWS Amplify,
//       Supabase, Pusher, LaunchDarkly, Segment, etc.
//   - Environment-specific URLs (staging, dev, production)
// ============================================================

import { DiscoveredConfig } from "../../types/contracts";

// ── PATTERN 1: Direct env variable access ────────────────────
const ENV_ACCESS_PATTERNS: RegExp[] = [
  // process.env.REACT_APP_API_URL = "..."
  /process\.env\.([A-Z][A-Z0-9_]{2,})\s*(?:[:=]|===?)\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // process.env["KEY"] or process.env['KEY']
  /process\.env\[["'`]([A-Z][A-Z0-9_]{2,})["'`]\]\s*(?:\?\?|:|\|\|)\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // import.meta.env.VITE_API_URL
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})\s*(?:\?\?|:|\|\|)\s*["'`]([^"'`\n]{2,200})["'`]/g,
  // window.__CONFIG__.KEY or window.__ENV__
  /(?:window|globalThis|self)\.__(\w+)__\s*[:=]\s*["'`]([^"'`\n]{2,200})["'`]/g,
];

// ── PATTERN 2: Config object blocks ──────────────────────────
const CONFIG_BLOCK_RE = /(?:config|CONFIG|Config|settings|SETTINGS|env|ENV|options|OPTIONS)\s*[:=]\s*\{([^}]{10,2000})\}/g;

// ── PATTERN 3: Feature flags ─────────────────────────────────
const FEATURE_FLAG_RE = /["'`]?(\w+(?:Feature|Flag|Enabled|Disabled|Toggle|Experiment))\s*["'`]?\s*:\s*(true|false)/gi;

// ── PATTERN 4: Third-party service configs ───────────────────
const SERVICE_CONFIG_PATTERNS: Array<{
  service: string;
  re: RegExp;
  keys: string[];
}> = [
  {
    service: "Firebase",
    re: /(?:firebase(?:Config)?|firebaseApp)\s*[:=]\s*\{([^}]{20,1000})\}/gi,
    keys: ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId", "measurementId"],
  },
  {
    service: "Sentry",
    re: /Sentry\.init\s*\(\s*\{([^}]{10,500})\}/gi,
    keys: ["dsn", "environment", "release", "tracesSampleRate"],
  },
  {
    service: "Stripe",
    re: /(?:Stripe|loadStripe)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    keys: ["publishableKey"],
  },
  {
    service: "Auth0",
    re: /(?:auth0|Auth0)\s*[:=]\s*\{([^}]{10,500})\}/gi,
    keys: ["domain", "clientId", "audience", "redirectUri"],
  },
  {
    service: "Algolia",
    re: /(?:algoliasearch|algolia)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi,
    keys: ["appId", "apiKey"],
  },
  {
    service: "Supabase",
    re: /createClient\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi,
    keys: ["supabaseUrl", "supabaseKey"],
  },
  {
    service: "Pusher",
    re: /(?:Pusher|pusher)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    keys: ["appKey"],
  },
  {
    service: "AWS/Amplify",
    re: /(?:Amplify|aws[_-]?config)\s*[:=]\s*\{([^}]{20,1000})\}/gi,
    keys: ["region", "userPoolId", "userPoolWebClientId", "identityPoolId"],
  },
];

// ── Key-value pair extraction inside config blocks ───────────
const PAIR_RE = /["'`]?(\w{2,40})["'`]?\s*:\s*["'`]([^"'`\n]{2,200})["'`]/g;
const BOOL_PAIR_RE = /["'`]?(\w{2,40})["'`]?\s*:\s*(true|false|\d+)/g;

// ── Environment URL patterns ─────────────────────────────────
const ENV_URL_RE = /(?:staging|dev(?:elopment)?|production|prod|beta|canary|preview)(?:Url|URL|_url|_URL|BaseUrl|Endpoint)\s*[:=]\s*["'`]([^"'`\n]+)["'`]/gi;

export function extractConfigs(
  code: string,
  sourceFile: string
): DiscoveredConfig[] {
  const seen = new Set<string>();
  const results: DiscoveredConfig[] = [];
  const lines = code.split("\n");

  const add = (key: string, value: string, line?: number) => {
    const dedupKey = `${key}::${value}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    results.push({ key, value, source_file: sourceFile, line });
  };

  let match: RegExpExecArray | null;

  // ── Phase 1: Direct env variable access ─────────────────────
  for (const pattern of ENV_ACCESS_PATTERNS) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(code)) !== null) {
      const line = getLineNumber(code, match.index);
      add(match[1], match[2], line);
    }
  }

  // ── Phase 2: Feature flags ──────────────────────────────────
  FEATURE_FLAG_RE.lastIndex = 0;
  while ((match = FEATURE_FLAG_RE.exec(code)) !== null) {
    const line = getLineNumber(code, match.index);
    add(match[1], match[2], line);
  }

  // ── Phase 3: Config block extraction ────────────────────────
  CONFIG_BLOCK_RE.lastIndex = 0;
  while ((match = CONFIG_BLOCK_RE.exec(code)) !== null) {
    const block = match[1];
    const blockLine = getLineNumber(code, match.index);

    // Extract string key-value pairs
    PAIR_RE.lastIndex = 0;
    let pairMatch: RegExpExecArray | null;
    while ((pairMatch = PAIR_RE.exec(block)) !== null) {
      add(pairMatch[1], pairMatch[2], blockLine);
    }

    // Extract boolean/numeric config values
    BOOL_PAIR_RE.lastIndex = 0;
    while ((pairMatch = BOOL_PAIR_RE.exec(block)) !== null) {
      // Only capture if key looks config-like
      const key = pairMatch[1];
      if (/(?:debug|enable|disable|mode|flag|feature|show|hide|allow|verbose|log)/i.test(key)) {
        add(key, pairMatch[2], blockLine);
      }
    }
  }

  // ── Phase 4: Third-party service configs ────────────────────
  for (const service of SERVICE_CONFIG_PATTERNS) {
    service.re.lastIndex = 0;
    while ((match = service.re.exec(code)) !== null) {
      const blockLine = getLineNumber(code, match.index);

      if (match.length >= 3 && service.keys.length >= 2) {
        // Direct arg patterns (e.g., algoliasearch(appId, apiKey))
        for (let i = 0; i < Math.min(match.length - 1, service.keys.length); i++) {
          if (match[i + 1]) {
            add(`${service.service}.${service.keys[i]}`, match[i + 1], blockLine);
          }
        }
      } else if (match[1]) {
        // Block patterns — parse key-value pairs inside
        if (match[1].includes(":")) {
          PAIR_RE.lastIndex = 0;
          let pairMatch: RegExpExecArray | null;
          while ((pairMatch = PAIR_RE.exec(match[1])) !== null) {
            if (service.keys.includes(pairMatch[1]) || service.keys.length === 0) {
              add(`${service.service}.${pairMatch[1]}`, pairMatch[2], blockLine);
            }
          }
        } else {
          // Single value capture (e.g., Stripe publishable key)
          add(`${service.service}.${service.keys[0]}`, match[1], blockLine);
        }
      }
    }
  }

  // ── Phase 5: Environment-specific URLs ──────────────────────
  ENV_URL_RE.lastIndex = 0;
  while ((match = ENV_URL_RE.exec(code)) !== null) {
    const line = getLineNumber(code, match.index);
    const key = match[0].split(/[:=]/)[0].trim().replace(/["'`]/g, "");
    add(key, match[1], line);
  }

  return results;
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function getLineNumber(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}
