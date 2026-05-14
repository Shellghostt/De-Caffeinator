// ============================================================
// STAGE 4 — KNOWN LIBRARY DETECTOR
//
// Fingerprints well-known libraries in the code and annotates
// them with a banner comment. This helps analysts immediately
// identify third-party code vs. application-specific code.
//
// Detection methods:
//   - Version string patterns (e.g. "easyXDM v2.4.15")
//   - Characteristic API signatures (e.g. jQuery.fn.extend)
//   - UMD/CJS module patterns with known names
// ============================================================

export interface LibraryDetectResult {
  code: string;
  detected: boolean;
  libraries: DetectedLibrary[];
}

export interface DetectedLibrary {
  name: string;
  version: string | null;
  confidence: "high" | "medium";
  /** Byte offset in the original code where the match was found */
  matchOffset: number;
}

interface LibraryFingerprint {
  name: string;
  patterns: RegExp[];
  versionPattern?: RegExp;
}

const LIBRARY_FINGERPRINTS: LibraryFingerprint[] = [
  {
    name: "jQuery",
    patterns: [
      /jQuery\.fn\.jquery\s*=/,
      /jQuery\.fn\.init/,
      /\bwindow\.jQuery\b/,
      /\$\.fn\.extend/,
    ],
    versionPattern: /jQuery\s+(?:JavaScript Library\s+)?v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "React",
    patterns: [
      /\breact\.production\.min/,
      /\.createElement\s*\(\s*["'](?:div|span|p|a|button)/,
      /__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/,
    ],
    versionPattern: /React\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "ReactDOM",
    patterns: [
      /\breact-dom\.production\.min/,
      /ReactDOM\.render/,
      /createRoot\s*\(/,
    ],
    versionPattern: /ReactDOM\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Angular",
    patterns: [
      /@angular\/core/,
      /ng\.core\.Component/,
      /\bNgModule\b.*declarations/,
    ],
    versionPattern: /@angular\/core.*?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Vue.js",
    patterns: [
      /Vue\.prototype\.\$mount/,
      /\bVue\.component\b/,
      /__vue__/,
    ],
    versionPattern: /Vue\.js\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Lodash",
    patterns: [
      /\b_\.VERSION\b/,
      /lodash\.templateSettings/,
      /\b_\.chunk\b.*\b_\.compact\b/,
    ],
    versionPattern: /lodash\s+(?:v|version\s+)?(\d+\.\d+\.\d+)/i,
  },
  {
    name: "Underscore.js",
    patterns: [
      /\b_\.VERSION\b/,
      /Underscore\.js/,
    ],
    versionPattern: /Underscore\.js\s+(\d+\.\d+\.\d+)/,
  },
  {
    name: "Moment.js",
    patterns: [
      /moment\.version/,
      /\bmoment\.locale\b/,
      /\bmoment\.duration\b/,
    ],
    versionPattern: /moment\.version\s*=\s*["'](\d+\.\d+\.\d+)["']/,
  },
  {
    name: "Axios",
    patterns: [
      /axios\.defaults/,
      /\baxios\.create\b/,
      /\baxios\.interceptors\b/,
    ],
    versionPattern: /axios\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "easyXDM",
    patterns: [
      /easyXDM/,
      /\.stack\.PostMessageTransport/,
      /\.stack\.FlashTransport/,
    ],
    versionPattern: /easyXDM.*?(\d+\.\d+\.\d+(?:\.\d+)?)/,
  },
  {
    name: "Socket.IO",
    patterns: [
      /\bio\.connect\b/,
      /\bsocket\.emit\b.*\bsocket\.on\b/,
      /io\.protocol/,
    ],
    versionPattern: /socket\.io.*?(\d+\.\d+\.\d+)/i,
  },
  {
    name: "D3.js",
    patterns: [
      /d3\.select/,
      /d3\.scale/,
      /d3\.svg\.axis/,
    ],
    versionPattern: /d3\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Three.js",
    patterns: [
      /THREE\.Scene/,
      /THREE\.WebGLRenderer/,
      /THREE\.PerspectiveCamera/,
    ],
    versionPattern: /three\.js.*?r?(\d+(?:\.\d+)*)/i,
  },
  {
    name: "Bootstrap",
    patterns: [
      /Bootstrap\s+v/,
      /\.modal\(.*toggle\)/,
      /data-bs-toggle/,
    ],
    versionPattern: /Bootstrap\s+v(\d+\.\d+\.\d+)/,
  },
  {
    name: "Polyfill / core-js",
    patterns: [
      /core-js/,
      /\bpolyfill\b.*\bPromise\b/i,
      /__core-js_shared__/,
    ],
    versionPattern: /core-js\s+v?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Google Analytics",
    patterns: [
      /GoogleAnalyticsObject/,
      /\bga\s*\(\s*["']create["']/,
      /google-analytics\.com\/analytics/,
      /gtag\s*\(\s*["']config["']/,
    ],
  },
  {
    name: "Google Tag Manager",
    patterns: [
      /googletagmanager\.com/,
      /\bdataLayer\b.*\bpush\b/,
    ],
  },
  {
    name: "Sentry",
    patterns: [
      /Sentry\.init/,
      /sentry\.io/,
      /\bSentry\.captureException\b/,
    ],
    versionPattern: /Sentry.*?(\d+\.\d+\.\d+)/,
  },
  {
    name: "Webpack Runtime",
    patterns: [
      /webpackJsonp/,
      /__webpack_require__/,
      /webpackChunk/,
    ],
  },
  {
    name: "Next.js Runtime",
    patterns: [
      /__NEXT_DATA__/,
      /\b_next\/static\b/,
      /next\/router/,
    ],
  },
];

export function detectLibraries(code: string): LibraryDetectResult {
  const detected: DetectedLibrary[] = [];
  const seen = new Set<string>();

  for (const fingerprint of LIBRARY_FINGERPRINTS) {
    // Need at least 1 pattern match
    let matched = false;
    let matchOffset = -1;
    let matchCount = 0;

    for (const pattern of fingerprint.patterns) {
      pattern.lastIndex = 0;
      const m = pattern.exec(code);
      if (m) {
        matchCount++;
        if (matchOffset === -1) matchOffset = m.index;
      }
    }

    if (matchCount === 0) continue;
    matched = true;

    // Determine confidence based on how many patterns matched
    const confidence: "high" | "medium" = matchCount >= 2 ? "high" : "medium";

    // Try to extract version
    let version: string | null = null;
    if (fingerprint.versionPattern) {
      fingerprint.versionPattern.lastIndex = 0;
      const vMatch = fingerprint.versionPattern.exec(code);
      if (vMatch) version = vMatch[1];
    }

    if (!seen.has(fingerprint.name)) {
      seen.add(fingerprint.name);
      detected.push({
        name: fingerprint.name,
        version,
        confidence,
        matchOffset,
      });
    }
  }

  if (detected.length === 0) {
    return { code, detected: false, libraries: [] };
  }

  // Build a banner comment and prepend it
  const bannerLines = [
    "// ============================================================",
    "// DETECTED LIBRARIES:",
  ];
  for (const lib of detected) {
    const ver = lib.version ? ` v${lib.version}` : "";
    bannerLines.push(`//   - ${lib.name}${ver} (${lib.confidence} confidence)`);
  }
  bannerLines.push(
    "// ============================================================",
    ""
  );

  const annotatedCode = bannerLines.join("\n") + code;

  return {
    code: annotatedCode,
    detected: true,
    libraries: detected,
  };
}
