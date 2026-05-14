# Blob Unpacker

**A production-grade JavaScript reverse engineering and asset analysis pipeline for security auditing.**

Blob Unpacker crawls a target website, downloads every JavaScript file it can find, de-obfuscates and de-minifies them using 12 different AST-based transforms, and then extracts security-relevant artifacts — API endpoints, secrets, developer comments, and configuration values. All output is organized into clean per-hostname directories ready for analysis.

---

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Usage](#usage)
  - [Interactive Launcher](#interactive-launcher)
  - [Direct CLI](#direct-cli)
  - [CLI Options](#cli-options)
- [Pipeline Architecture](#pipeline-architecture)
  - [Stage 1 — Ingestion](#stage-1--ingestion)
  - [Stage 2 — Source Map Detection](#stage-2--source-map-detection)
  - [Stage 3 — Source Reconstruction](#stage-3--source-reconstruction)
  - [Stage 4 — De-obfuscation & De-minification](#stage-4--de-obfuscation--de-minification)
  - [Stage 5 — Artifact Extraction](#stage-5--artifact-extraction)
  - [Stage 6 — Output](#stage-6--output)
- [Output Structure](#output-structure)
- [De-obfuscation Techniques](#de-obfuscation-techniques)
- [Extraction Capabilities](#extraction-capabilities)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Automated JS Discovery** — Crawls HTML pages, follows same-origin links, parses Webpack chunk IDs, and fetches Next.js `_buildManifest.js` to find every JavaScript file on a target site.
- **12 De-obfuscation Transforms** — Eval unpacking, string array resolution, hex call resolution, unicode decoding, constant folding, IIFE alias resolution, context-based variable renaming, dead code elimination, control flow unflattening, bundle splitting, library detection, and beautification.
- **Source Map Recovery** — Automatically probes for `.map` files and reconstructs original TypeScript/React source code when available.
- **Security Artifact Extraction** — Discovers API endpoints, hardcoded secrets, developer comments, and environment configuration values.
- **Per-Hostname Output** — Each scanned website gets its own output directory with deobfuscated JS, extracted artifacts, and a human-readable summary report.
- **Recursive Unpacking** — If code is still packed after a full pass, Stage 4 re-runs automatically (up to a configurable depth).
- **Library Fingerprinting** — Identifies 20+ known libraries (jQuery, React, easyXDM, Lodash, etc.) and annotates them in the output.
- **Content-Hash Deduplication** — Same JS file across multiple pages is only processed once.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/addydude/De-Caffeinator.git
cd De-Caffeinator/blob-unpacker

# Install dependencies
npm install

# Run against a target
npx ts-node src/index.ts https://example.com

# Or use the interactive launcher
python run.py
```

---

## Installation

### Prerequisites

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Python** >= 3.8 (optional, for the interactive launcher)

### Setup

```bash
cd blob-unpacker
npm install
```

This installs all required dependencies including Babel (for AST transforms), js-beautify, source-map parser, and the HTTP client.

---

## Usage

### Interactive Launcher

The recommended way to run Blob Unpacker is through the interactive Python launcher:

```bash
python run.py
```

This presents a menu-driven interface with preset scan profiles:

| Profile | Depth | Pages | Concurrency | Best For |
|---------|-------|-------|-------------|----------|
| **Quick Scan** | 1 | 20 | 3 | Initial recon |
| **Full Scan** | 3 | 100 | 5 | Thorough analysis |
| **Deep Scan** | 5 | 500 | 8 | Large applications |
| **Stealth Scan** | 2 | 50 | 2 | Rate-limited targets |

### Direct CLI

```bash
npx ts-node src/index.ts <url> [options]
```

### CLI Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--output <dir>` | `-o` | `./output` | Output directory |
| `--format <fmt>` | `-f` | `json` | Data format: `json` or `jsonl` |
| `--depth <n>` | `-d` | `2` | Max crawl depth for link following |
| `--pages <n>` | `-p` | `50` | Max pages to crawl |
| `--concurrency <n>` | `-c` | `5` | Max concurrent HTTP requests |
| `--timeout <ms>` | `-t` | `15000` | HTTP request timeout in ms |
| `--delay <ms>` | | `300` | Politeness delay between requests |
| `--deobf-depth <n>` | | `5` | Max recursive de-obfuscation passes |
| `--entropy <n>` | | `4.5` | Min Shannon entropy for secret detection |
| `--no-chunks` | | | Disable dynamic chunk discovery |
| `--no-files` | | | Don't write source/deobfuscated files |
| `--user-agent <str>` | | | Custom User-Agent string |

### Examples

```bash
# Basic scan
npx ts-node src/index.ts https://example.com

# Full scan with custom output
npx ts-node src/index.ts https://example.com -o ./results -d 3 -p 100

# Deep scan with high concurrency
npx ts-node src/index.ts https://example.com --depth 5 --pages 500 -c 10

# Stealth mode — slow and polite
npx ts-node src/index.ts https://example.com -c 2 --delay 1000 --timeout 30000

# Skip chunk discovery, JSONL output
npx ts-node src/index.ts https://example.com --no-chunks -f jsonl
```

---

## Pipeline Architecture

Blob Unpacker processes JavaScript through a 6-stage pipeline. Each asset flows through the stages independently, with concurrency managed by an internal queue.

```
                       ┌─────────────────────┐
                       │    CLI / run.py      │
                       │    src/index.ts      │
                       └─────────┬───────────┘
                                 │
                       ┌─────────▼───────────┐
                       │  PipelineContext     │
                       │  (config, logger,    │
                       │   state, results)    │
                       └─────────┬───────────┘
                                 │
                  ┌──────────────▼──────────────┐
                  │    Stage 1: Ingestion        │
                  │    Discover & download JS    │
                  └──────────────┬──────────────┘
                                 │ AssetRecord[]
                       ┌─────────▼───────────┐
                       │    AssetQueue        │
                       │    (dedup, concur.)  │
                       └─────────┬───────────┘
                                 │ per asset
                  ┌──────────────▼──────────────┐
                  │  Stage 2: Map Detection      │
                  │  Check for .map files        │
                  └──────┬──────────────┬───────┘
                         │              │
                    map found       no map
                         │              │
              ┌──────────▼──────┐ ┌─────▼────────────┐
              │  Stage 3:       │ │  Stage 4:          │
              │  Reconstruction │ │  De-obfuscation    │◄─┐
              │  (source map)   │ │  (12 transforms)   │──┘ recursive
              └──────┬──────────┘ └─────┬────────────┘    if still packed
                     │                  │
                     │  unmapped chunks │
                     │        ├─────────┘
                     │        │
              ┌──────▼────────▼─────────┐
              │  Stage 5: Extraction     │
              │  Endpoints, secrets,     │
              │  comments, configs       │
              └──────────┬──────────────┘
                         │
              ┌──────────▼──────────────┐
              │  Stage 6: Output         │
              │  Per-hostname dirs,      │
              │  JSON, reports, summary  │
              └─────────────────────────┘
```

### Stage 1 — Ingestion

Discovers and downloads every JavaScript file from the target site using a multi-phase approach:

| Phase | What It Does |
|-------|-------------|
| **1 — Entry Page** | Fetches root HTML, extracts all `<script src>` tags and inline `<script>` blocks |
| **1b — Next.js Manifest** | Detects `buildId`, fetches `/_next/static/<id>/_buildManifest.js`, discovers all page-specific chunks |
| **2 — Link Following** | Parses `<a href>` tags for same-origin pages, fetches them, repeats Phase 1 |
| **3 — Chunk Discovery** | Scans downloaded JS bundles for Webpack/Rollup chunk IDs and fetches them |

All assets are deduplicated by SHA-256 content hash before entering the processing queue.

### Stage 2 — Source Map Detection

For each JS asset, probes for a source map by:
1. Scanning for `//# sourceMappingURL=` comments
2. Probing `<asset_url>.map` via HTTP
3. Checking response headers for `SourceMap` or `X-SourceMap`

If found, the full `.map` file is fetched and passed to Stage 3. If not, the asset goes directly to Stage 4.

### Stage 3 — Source Reconstruction

Only runs when a source map is available. Parses VLQ-encoded mappings to recover original source files:

- **Full reconstruction** — When `sourcesContent` is present, restores every original file verbatim with the original directory structure
- **Partial reconstruction** — When only source paths are available, creates fragment files from mapped ranges
- **Path-only** — When the map has no content, records known file paths for reference

Any portions that couldn't be mapped are forwarded to Stage 4 as unmapped chunks.

### Stage 4 — De-obfuscation & De-minification

The core processing engine. Applies **12 transforms** in optimal order via Babel AST:

| # | Transform | What It Does |
|---|-----------|-------------|
| 1 | Eval Unpacking | Extracts payloads from `eval(function(p,a,c,k,e,d){...})` wrappers |
| 2 | Hex Call Resolution | Resolves `_0x1a2b('0x1f')` → original string values |
| 3 | String Array Resolution | Replaces array-index lookups with the actual strings |
| 4 | Unicode Decoding | Converts `\u0048\u0065\u006C\u006C\u006F` → `Hello` |
| 5 | Constant Folding | Evaluates `"hel" + "lo"` → `"hello"`, `1 + 2 * 3` → `7` |
| 5b | **IIFE Alias Resolution** | `(function(N,d){...})(window,document)` → replaces `N`→`window`, `d`→`document` |
| 5c | **Context-Based Renaming** | Infers `n.createElement("div")` → `document.createElement("div")` from usage patterns |
| 6 | Dead Code Elimination | Removes `if(false){...}`, unreachable branches |
| 7 | Control Flow Unflattening | Reverses switch-case state machine obfuscation |
| 8 | Bundle Splitting | Splits Webpack/Rollup/Vite bundles into individual modules |
| 8b | **Library Detection** | Fingerprints 20+ libraries (jQuery, React, easyXDM, etc.) and annotates them |
| 9 | Beautification | Final formatting with consistent indentation |

**Recursion Rule:** If the output is still detected as packed (eval wrappers, `p,a,c,k,e,d` patterns), Stage 4 feeds its own output back in — up to `--deobf-depth` times (default: 5).

### Stage 5 — Artifact Extraction

Runs four independent extractors on the readable code:

| Extractor | Finds | Confidence Levels |
|-----------|-------|-------------------|
| **Endpoint Extractor** | `fetch()`, `axios`, `$.ajax()`, XHR `.open()`, route definitions | High / Medium / Low |
| **Secret Extractor** | API keys, JWTs, private keys, DB URLs, bearer tokens | Based on Shannon entropy + pattern matching |
| **Comment Extractor** | `TODO`, `FIXME`, `password`, `hack`, internal notes | Category-based |
| **Config Extractor** | `process.env.*`, `__NEXT_DATA__`, feature flags | Key-value pairs |

### Stage 6 — Output

Organizes all findings into per-hostname directories. Each website gets its own folder containing deobfuscated JS, extracted artifacts, JSON reports, and a human-readable summary.

---

## Output Structure

```
output/
├── index.json                    # Global summary of all scanned hosts
├── run-report.json               # Aggregate pipeline stats
├── pipeline.log.jsonl            # Full structured event log
└── <hostname>/                   # One folder per website
    ├── deobfuscated/             # Beautified + de-obfuscated JS
    │   ├── main-chunk.js
    │   └── vendor-chunk.js
    ├── raw/                      # Original downloaded JS (if different)
    ├── sources/                  # Source-map reconstructed files
    │   └── <hash>/
    │       ├── src/App.tsx
    │       ├── src/utils.ts
    │       └── _file_index.txt
    ├── manifests/
    │   ├── endpoints-contract.json
    │   └── artifacts-contract.json
    ├── endpoints.json            # All discovered API endpoints
    ├── secrets.json              # Hardcoded secrets and tokens
    ├── comments.json             # Security-relevant dev comments
    ├── configs.json              # Environment and config values
    ├── artifact-index.json       # Per-asset finding counts
    ├── run-report.json           # Per-host stats
    └── summary.md                # Human-readable findings report
```

---

## De-obfuscation Techniques

### Obfuscation Reversal
- **Eval/Packer Unwrapping** — Safely extracts code hidden inside `eval()`, `new Function()`, and Dean Edwards packer (`p,a,c,k,e,d`) wrappers
- **Hex Function Call Resolution** — Resolves encoded function calls like `window['\x61\x6c\x65\x72\x74']()` → `window.alert()`
- **String Array Resolution** — Replaces obfuscator.io-style string array lookups with the actual string values
- **Unicode/Hex String Decoding** — Converts `\u0041` back to `A` across all string literals
- **Control Flow Unflattening** — Reconstructs linear code from switch-case state machine patterns used by advanced obfuscators

### De-minification
- **IIFE Parameter Alias Resolution** — When a minifier wraps code in `(function(w,d,l){...})(window,document,location)`, restores all parameter aliases to their original global names. Supports 110+ known globals.
- **Context-Based Variable Renaming** — Infers variable identities from usage patterns. If a single-letter variable calls `.createElement()`, `.getElementById()`, and `.querySelector()`, it's renamed to `document`. Covers 12 context rules for `document`, `window`, `console`, `JSON`, `Math`, `Object`, `Array`, `Promise`, `navigator`, `location`, `history`, and `localStorage`.

### Code Cleanup
- **Constant Folding** — Evaluates compile-time-constant expressions (`"hel" + "lo"` → `"hello"`)
- **Dead Code Elimination** — Removes unreachable code paths (`if(false){...}`, `if(1===2){...}`)
- **Bundle Splitting** — Separates Webpack/Rollup/Vite/Turbopack bundles into individual module files
- **Library Detection** — Fingerprints 20+ libraries and adds banner comments identifying them
- **Beautification** — Consistent indentation and formatting via js-beautify

---

## Extraction Capabilities

### Endpoints
Discovers API endpoints from:
- `fetch("/api/...")` and `fetch(baseUrl + "/path")`
- `axios.get()`, `axios.post()`, etc.
- `$.ajax()`, `$.get()`, `$.post()`
- `XMLHttpRequest.open("GET", "/api/...")`
- React Router / Next.js route definitions
- Express-style route patterns

### Secrets
Detects via pattern matching + Shannon entropy scoring:
- API keys (AWS, Google, Stripe, etc.)
- JWT tokens and secrets
- Database connection strings
- Private keys (RSA, EC)
- Bearer tokens
- Hardcoded credentials
- High-entropy unknown strings

### Comments
Flags security-relevant developer comments containing:
- `TODO`, `FIXME`, `HACK`, `XXX`
- `password`, `secret`, `credential`
- `internal`, `deprecated`, `insecure`

### Configs
Extracts configuration values from:
- `process.env.REACT_APP_*`
- `__NEXT_DATA__` payloads
- Feature flag definitions
- Build metadata and version strings

---

## Project Structure

```
blob-unpacker/
├── run.py                          # Interactive Python launcher
├── package.json                    # Node.js dependencies
├── tsconfig.json                   # TypeScript configuration
└── src/
    ├── index.ts                    # CLI entry point & argument parser
    ├── core/
    │   ├── context.ts              # PipelineContext, config, logger, state
    │   ├── pipeline.ts             # PipelineOrchestrator (stage runner)
    │   └── queue.ts                # AssetQueue (dedup, concurrency)
    ├── lib/
    │   ├── http.ts                 # HTTP fetch with retry & timeout
    │   ├── hasher.ts               # SHA-256 content hashing
    │   └── paths.ts                # Per-hostname output dir helpers
    ├── stages/
    │   ├── 1-ingestion/
    │   │   ├── index.ts            # runIngestion() entry point
    │   │   ├── crawler-adapter.ts  # Multi-phase crawl orchestration
    │   │   ├── link-follower.ts    # Same-origin <a href> BFS
    │   │   ├── chunk-discoverer.ts # Webpack chunk ID extraction
    │   │   ├── classifier.ts       # Asset type classification
    │   │   └── spider-adapter.ts   # Spider mode adapter
    │   ├── 2-map-detection/
    │   │   ├── index.ts            # detectMap() entry point
    │   │   ├── comment-scanner.ts  # sourceMappingURL parser
    │   │   ├── header-inspector.ts # HTTP header check
    │   │   └── path-inferrer.ts    # .map URL inference
    │   ├── 3-reconstruction/
    │   │   ├── index.ts            # reconstruct() entry point
    │   │   ├── full-reconstructor.ts
    │   │   ├── partial-reconstructor.ts
    │   │   ├── map-parser.ts       # Source map JSON parser
    │   │   ├── vlq-decoder.ts      # VLQ base64 decoder
    │   │   ├── name-recovery.ts    # Variable name recovery
    │   │   └── source-writer.ts    # File writer → sources/<hash>/
    │   ├── 4-deobfuscation/
    │   │   ├── index.ts            # deobfuscate() entry point
    │   │   ├── eval-unpacker.ts    # eval/packer unwrapping
    │   │   ├── hex-call-resolver.ts
    │   │   ├── string-array-resolver.ts
    │   │   ├── unicode-decoder.ts
    │   │   ├── constant-folder.ts
    │   │   ├── iife-alias-resolver.ts   # NEW: IIFE param aliasing
    │   │   ├── context-renamer.ts       # NEW: Usage-based renaming
    │   │   ├── dead-code-eliminator.ts
    │   │   ├── control-flow-unflattener.ts
    │   │   ├── bundle-splitter.ts
    │   │   ├── webpack-splitter.ts
    │   │   ├── library-detector.ts      # NEW: Library fingerprinting
    │   │   └── beautifier.ts
    │   ├── 5-extraction/
    │   │   ├── index.ts            # extract() entry point
    │   │   ├── endpoint-extractor.ts
    │   │   ├── secret-extractor.ts
    │   │   ├── comment-extractor.ts
    │   │   ├── config-extractor.ts
    │   │   ├── ast-extractor.ts    # Deep Babel AST walk
    │   │   └── entropy.ts          # Shannon entropy scorer
    │   └── 6-output/
    │       ├── index.ts            # writeOutputs() — per-host grouping
    │       ├── deobfuscated-writer.ts
    │       └── schema.ts           # Output schema definitions
    └── types/
        └── contracts.ts            # All shared TypeScript interfaces
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js / TypeScript |
| **AST Parsing** | `@babel/parser` |
| **AST Transforms** | `@babel/traverse`, `@babel/types` |
| **Code Generation** | `@babel/generator` |
| **Beautification** | `js-beautify` |
| **Source Maps** | `source-map` |
| **Schema Validation** | `zod` |
| **HTTP Client** | `got` |
| **Launcher** | Python 3 (optional) |

---

## Known Limitations

1. **Static Crawler** — The crawler does not execute JavaScript. Client-side routes loaded purely via SPA navigation (e.g., Next.js `<Link>`) won't be found through link following. The Next.js `buildManifest` integration partially compensates.

2. **No Headless Browser** — For sites that require JavaScript execution to render content (heavy SPAs), a Puppeteer/Playwright integration would improve coverage.

3. **Context Renaming is Heuristic** — The variable renamer uses usage pattern analysis, not data flow analysis. It requires multiple signals before renaming to avoid false positives. Some minified variables may not be renamed if their usage is ambiguous.

4. **Secret Detection False Positives** — High-entropy strings (like CSS class hashes or content hashes) may be flagged as potential secrets. The entropy threshold (`--entropy`) can be tuned.

5. **No Authentication** — The crawler does not support authenticated sessions. Pages behind login walls are not crawled.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the pipeline against a test target to verify
5. Submit a pull request

---

## License

This project is for educational and authorized security testing purposes only. Always obtain permission before scanning websites you don't own.
