# Blob Unpacker: Architecture and Pipeline Overview

## Introduction
Blob Unpacker is an advanced, rule-based JavaScript reverse engineering and asset analysis pipeline. It is designed to take compiled, minified, or obfuscated JavaScript bundles—typical of modern web applications (like SPAs built with React, Vue, or Angular)—and systematically reverse-engineer them. The goal is to recover original source code, expose hidden endpoints, and uncover hardcoded secrets.

---

## The Core Engine
The Core Engine acts as the brain of the pipeline. It orchestrates the flow of data between stages, maintains state, and handles concurrency. 

### 1. Pipeline Context (`context.ts`)
The `PipelineContext` is the global state manager. It holds configuration settings (crawl depth, timeouts, thresholds) and maintains global registries (e.g., seen URLs, output directories). It also provides a centralized logger for the entire pipeline.

### 2. Asset Queue (`queue.ts`)
The `AssetQueue` manages the workflow. As the pipeline discovers new JavaScript files, chunks, or source maps, they are pushed into the queue. The queue ensures that assets are processed systematically without duplicating effort (by tracking hashes and URLs).

### 3. Pipeline Orchestrator (`pipeline.ts`)
The `PipelineOrchestrator` runs the main loop. It pulls assets from the queue and passes them through the defined stages (Map Detection, Reconstruction, Deobfuscation, Extraction). It manages concurrency, ensuring that multiple assets are analyzed in parallel without exhausting system resources.

---

## The 5-Stage Pipeline

The actual analysis happens in a sequential 5-stage pipeline.

### STAGE 1: Ingestion & Discovery
**Goal:** Find every piece of JavaScript associated with the target application.
- **Sitemap Discovery:** Probes `/robots.txt` and `/sitemap.xml`, expands sub-sitemaps, and feeds all page URLs into the discovery queue to bypass HTML link depth limits.
- **Crawler Adapter:** Connects to the entry point (URL) and fetches the initial HTML/JS. Employs HTML entity decoding and modern User-Agent spoofing to bypass basic bot protection.
- **Link Follower:** Parses the HTML to find `<script>` tags and dynamically injected bundles. Crawls same-origin links using a priority scoring system (prioritizing high-value pages over repetitive product pages).
- **Playwright Crawler (SPA_DOM):** Launches a real headless Chrome browser to fully render the page and execute JavaScript, intercepting dynamic network requests to capture lazy-loaded or conditionally injected scripts.
- **Wayback Machine CDX:** Queries the Internet Archive's Capture Index to unearth orphaned or historically deployed JavaScript files (and their source maps) that are no longer linked in modern HTML.
- **Chunk Discovery:** Analyzes the JavaScript code looking for dynamic imports (`import()`), Webpack/Vite chunk loaders, or literal chunk path strings, downloading secondary files that are not immediately loaded by the browser.

### STAGE 2: Source Map Detection
**Goal:** Determine if the developer accidentally left Source Maps exposed, which are the holy grail of reverse engineering.
- **Comment Scanner:** Looks for `//# sourceMappingURL=...` comments at the bottom of JS files, with explicit safeguards for inline scripts.
- **Path Inferrer:** Even if the comment is missing, it guesses common source map locations (e.g., `/js/app.js.map`, `/sourcemaps/app.js.map`). Features query-string stripping and robust HEAD/GET fallback probing with JSON content validation (checking for `sources` and `mappings`) to avoid false positives from SPA catch-all routes.
- **Inline Data Extractor:** Detects and parses base64-encoded inline source maps directly embedded in the JS code.

### STAGE 3: Source Reconstruction
**Goal:** Rebuild the original source code tree if a source map is found.
- **Map Parser & VLQ Decoder:** Reads the Source Map file and decodes the complex Base64-VLQ mappings that link the minified code back to the original source lines.
- **Source Extractor:** Uses the `sourcesContent` array to write out the exact, original developer code (React components, TypeScript files, etc.) recreating the original directory structure (e.g., `src/components/Login.tsx`).
- **Name Recovery:** If the source map lacks full source content but has a `names` array, this module replaces mangled variables (e.g., `a`, `b`, `c`) in the minified code with their original names, vastly improving readability.

### STAGE 4: De-obfuscation
**Goal:** Make the JavaScript human-readable if source maps are *not* available. This is crucial for heavily obfuscated or packed code.
- **webcrack Integration:** The pipeline utilizes the `webcrack` engine to unpack Webpack/Browserify modules and resolve complex obfuscation patterns.
- **Constant Folding & String Resolution:** Evaluates math and string operations dynamically (e.g., `"a" + "b"` becomes `"ab"`). 
- **Hex/Unicode Resolution:** Converts `_0x1a2b` style hex identifiers and `\x48\x65\x6c\x6c\x6f` strings back to readable ASCII.
- **Control Flow Unflattening:** Resolves `switch-case` state machines used by obfuscators to hide the logical flow of the code.
- **Code Beautification:** Runs `js-beautify` to properly indent and format the final output.

### STAGE 5: Artifact Extraction
**Goal:** Scan the readable code for security vulnerabilities, secrets, and API endpoints.
- **AST Extractor:** Parses the deobfuscated JavaScript into an Abstract Syntax Tree (AST) using `acorn`. This allows the pipeline to programmatically understand the code (e.g., "find all function calls to `fetch` or `axios`").
- **Endpoint Discovery:** Extracts URLs, REST paths, and WebSocket addresses.
- **Secret Extractor (Entropy-based):** Uses advanced regex patterns and Shannon Entropy analysis to find hardcoded passwords, AWS keys, Stripe tokens, and Firebase configurations.
- **Comment Classification:** Extracts developer comments (which often leak internal data) and flags them as `TODO`, `FIXME`, or `SECURITY`.

---

## Output
Finally, the pipeline aggregates all findings into structured JSON files (`endpoints.json`, `secrets.json`, `configs.json`) and writes out the reconstructed source files to the output directory, making it ready for a Source Auditor to review. Crucially, the output is segregated: primary target application assets are kept in the root of the site's folder, while all recognized external dependencies (like analytics, ads, and widgets) are neatly separated into a `third-party/` subdirectory. This target-centric structure ensures that security engineers can focus entirely on the primary codebase without wasting time reviewing third-party vendor code.
