# Blob Unpacker

**A production-grade JavaScript reverse engineering and asset analysis pipeline for security auditing.**

Blob Unpacker crawls a target website, downloads every JavaScript file it can find, de-obfuscates and de-minifies them using the powerful webcrack engine, and then extracts security-relevant artifacts — API endpoints, secrets, developer comments, and configuration values. All output is organized into clean per-hostname directories ready for analysis.

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
- **Webcrack De-obfuscation** — Powered by the modern `webcrack` engine to automatically unbundle Webpack/Browserify modules, resolve obfuscator.io string arrays, fold constants, and remove dead code.
- **Source Map Recovery** — Automatically probes for `.map` files and reconstructs original TypeScript/React source code when available.
- **Security Artifact Extraction** — Discovers API endpoints, hardcoded secrets, developer comments, and environment configuration values using fast `acorn` AST parsing.
- **Clean Per-Hostname Output** — Each scanned website gets its own output directory. Third-party assets are neatly segregated into a `third-party/` subfolder to keep the primary target analysis focused.
- **Recursive Unpacking** — If code is still explicitly packed (e.g., using `eval()` or dean edwards packing) after a full pass, Stage 4 unwraps it and re-runs automatically (up to a configurable depth).
- **False-Positive Filtered Secrets** — Entropy-based secret detection tuned with robust heuristics to filter out hashes, CSS class names, and common false positives.
- **Content-Hash Deduplication** — Same JS file across multiple pages is only processed once.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/shellghostt/De-Caffeinator.git
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

---

## Pipeline Architecture

Blob Unpacker processes JavaScript through a 6-stage pipeline. Each asset flows through the stages independently, with concurrency managed by an internal queue.

```text
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
              │  Stage 3:       │ │  Stage 4:        │
              │  Reconstruction │ │  De-obfuscation  │◄─┐
              │  (source map)   │ │  (webcrack)      │──┘ recursive
              └──────┬──────────┘ └─────┬────────────┘    if still packed
                     │                  │                 (e.g., eval wrappers)
                     │  unmapped chunks │
                     │        ├─────────┘
                     │        │
              ┌──────▼────────▼─────────┐
              │  Stage 5: Extraction    │
              │  Endpoints, secrets,    │
              │  comments, configs      │
              └──────────┬──────────────┘
                         │
              ┌──────────▼──────────────┐
              │  Stage 6: Output        │
              │  Per-hostname dirs,     │
              │  JSON, reports, summary │
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

The core processing engine. Relies on the modern, high-performance **webcrack** engine to analyze and unpack complex minified bundles:

- **Bundle Splitting** — Identifies and unpacks Webpack and Browserify bundles, separating them into individual modules.
- **Obfuscator Reversal** — Automatically resolves obfuscator.io patterns, including string array rotation and control flow flattening.
- **Constant Folding & Unicode Decoding** — Evaluates constants and reverts hex/unicode encoded identifiers back to readable strings.
- **Beautification** — Final formatting with consistent indentation.

**Recursion Rule:** The 'isPacked' heuristic looks for explicit packing wrappers (e.g., `eval(function(p,a,c,k,e,d)...)`). If detected, it unwraps the payload and feeds it back into Stage 4 — up to `--deobf-depth` times (default: 5).

### Stage 5 — Artifact Extraction

Runs four independent extractors on the readable code, powered by fast `acorn` AST parsing (completely avoiding regexes on raw code where possible):

| Extractor | Finds | Confidence Levels |
|-----------|-------|-------------------|
| **Endpoint Extractor** | `fetch()`, `axios`, `$.ajax()`, XHR `.open()`, route definitions | High / Medium / Low |
| **Secret Extractor** | API keys, JWTs, private keys, DB URLs, bearer tokens | Based on Shannon entropy + heuristics |
| **Comment Extractor** | `TODO`, `FIXME`, `password`, `hack`, internal notes | AST Comment Node categorization |
| **Config Extractor** | `process.env.*`, `__NEXT_DATA__`, feature flags | Key-value pairs |

### Stage 6 — Output

Organizes all findings into per-hostname directories. Primary target assets are kept in the root, while third-party scripts (e.g., Google Analytics, Intercom) are cleanly segregated into a `third-party/` subfolder.

---

## Output Structure

```text
output/
├── index.json                    # Global summary of all scanned hosts
├── run-report.json               # Aggregate pipeline stats
├── pipeline.log.jsonl            # Full structured event log
└── <hostname>/                   # One folder per website
    ├── deobfuscated/             # Beautified + de-obfuscated JS for primary target
    │   └── main-chunk.js
    ├── raw/                      # Original downloaded JS
    ├── sources/                  # Source-map reconstructed files
    │   └── <hash>/
    │       ├── src/App.tsx
    │       └── src/utils.ts
    ├── third-party/              # Clean segregation of 3rd party assets
    │   ├── deobfuscated/
    │   │   └── analytics.js
    │   └── raw/
    │       └── analytics.js
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
- **Eval/Packer Unwrapping** — Safely extracts code hidden inside `eval()`, `new Function()`, and Dean Edwards packer (`p,a,c,k,e,d`) wrappers.
- **Obfuscator.io Reversal** — Automatically resolves string arrays, un-rotates array indices, and simplifies control flow flattening.
- **Hex/Unicode String Decoding** — Converts `\u0041` and `_0x1a2b` back to readable strings.
- **Control Flow Unflattening** — Reconstructs linear code from switch-case state machine patterns used by advanced obfuscators.

### Code Cleanup & Splitting
- **Bundle Splitting** — Separates Webpack/Browserify bundles into individual module files, drastically improving readability of large single-page applications.
- **Constant Folding** — Evaluates compile-time-constant expressions (`"hel" + "lo"` → `"hello"`).
- **Dead Code Elimination** — Removes unreachable code paths (`if(false){...}`).
- **Beautification** — Consistent indentation and formatting via js-beautify.

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
Detects via AST traversal + Shannon entropy scoring (with strict false-positive filtering):
- API keys (AWS, Google, Stripe, etc.)
- JWT tokens and secrets
- Database connection strings
- Private keys (RSA, EC)
- Bearer tokens
- Hardcoded credentials

### Comments
Parses the Abstract Syntax Tree (AST) to extract real developer comments (ignoring object properties or variable names) and flags those containing:
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

```text
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
    │   │   └── ...                 # Web crawlers, link followers, chunk discoverers
    │   ├── 2-map-detection/
    │   │   ├── index.ts            # detectMap() entry point
    │   │   └── ...                 # Comment scanners, HTTP headers, path inference
    │   ├── 3-reconstruction/
    │   │   ├── index.ts            # reconstruct() entry point
    │   │   └── ...                 # VLQ decoding, source extractors
    │   ├── 4-deobfuscation/
    │   │   ├── index.ts            # deobfuscate() entry point (webcrack wrapper)
    │   │   ├── eval-unpacker.ts    # Unwrapping eval payloads
    │   │   └── beautifier.ts       # Code formatting
    │   ├── 5-extraction/
    │   │   ├── index.ts            # extract() entry point
    │   │   ├── ast-extractor.ts    # Base acorn traversal class
    │   │   ├── endpoint-extractor.ts
    │   │   ├── secret-extractor.ts # Entropy and heuristic filtering
    │   │   ├── comment-extractor.ts# True comment extraction
    │   │   ├── config-extractor.ts
    │   │   └── entropy.ts          # Shannon entropy scorer
    │   └── 6-output/
    │       ├── index.ts            # writeOutputs() — per-host grouping
    │       └── schema.ts           # Output schema definitions
    └── types/
        └── contracts.ts            # Shared TypeScript interfaces
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js / TypeScript |
| **AST Parsing** | `acorn`, `acorn-walk` |
| **De-obfuscation Engine** | `webcrack` |
| **Beautification** | `js-beautify` |
| **Source Maps** | `source-map` |
| **Schema Validation** | `zod` |
| **HTTP Client** | `got` |
| **Launcher** | Python 3 (optional) |

---

## Known Limitations

1. **Static Crawler** — The crawler does not execute JavaScript. Client-side routes loaded purely via SPA navigation (e.g., Next.js `<Link>`) won't be found through link following. The Next.js `buildManifest` integration partially compensates.

2. **No Headless Browser** — For sites that require JavaScript execution to render content (heavy SPAs), a Puppeteer/Playwright integration would improve coverage.

3. **Secret Detection False Positives** — High-entropy strings (like CSS class hashes or content hashes) may occasionally be flagged as potential secrets, although the strict false-positive heuristics mitigate most of this. The entropy threshold (`--entropy`) can be tuned.

4. **No Authentication** — The crawler does not support authenticated sessions. Pages behind login walls are not crawled.

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
