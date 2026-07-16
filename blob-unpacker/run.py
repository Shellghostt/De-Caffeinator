#!/usr/bin/env python3
"""
Blob Unpacker - CLI Launcher
Thin wrapper around the Node.js pipeline CLI.

Usage:
    python run.py <url> [options]
    python run.py https://example.com
    python run.py https://example.com -o ./results -d 3 -p 100
    python run.py https://example.com --quick
    python run.py https://example.com --stealth
    python run.py https://example.com --deep
"""

import os
import sys
import subprocess
from datetime import datetime

# Force UTF-8 output on Windows
if os.name == "nt":
    os.system("chcp 65001 >nul 2>&1")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Colors ──────────────────────────────────────────────────
class C:
    HEADER  = "\033[95m"
    BLUE    = "\033[94m"
    CYAN    = "\033[96m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    RED     = "\033[91m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    RESET   = "\033[0m"


def main():
    # Ensure we're in the right directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    if not os.path.exists("src/index.ts"):
        print(f"{C.RED}Error: src/index.ts not found. Run this from the blob-unpacker directory.{C.RESET}")
        sys.exit(1)

    # Pass all arguments directly to the Node.js CLI
    args = sys.argv[1:]

    if len(args) == 0 or args[0] in ("--help", "-h"):
        print(f"""
{C.CYAN}{C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                      BLOB UNPACKER                         ║
║    JavaScript Reverse Engineering & Asset Analysis Tool     ║
╚══════════════════════════════════════════════════════════════╝{C.RESET}

{C.BOLD}USAGE:{C.RESET}
  python run.py <url> [options]

{C.BOLD}EXAMPLES:{C.RESET}
  python run.py https://example.com
  python run.py https://example.com -o ./results
  python run.py https://example.com -d 3 -p 100
  python run.py https://example.com --quick
  python run.py https://example.com --stealth
  python run.py https://example.com --deep

{C.BOLD}PRESETS:{C.RESET}
  {C.GREEN}(default){C.RESET}   Full power: depth=3, pages=100, all techniques
  {C.GREEN}--quick{C.RESET}     Entry page only, no chunks, fast
  {C.GREEN}--stealth{C.RESET}   Low concurrency, high delays, avoids detection
  {C.GREEN}--deep{C.RESET}      Max coverage: depth=5, pages=200, low entropy

{C.BOLD}OPTIONS:{C.RESET}
  -o, --output <dir>     Output directory (default: ./output)
  -d, --depth <n>        Crawl depth (default: 3)
  -p, --pages <n>        Max pages (default: 100)
  -c, --concurrency <n>  Concurrent requests (default: 5)
  -t, --timeout <ms>     Request timeout (default: 20000)
  --delay <ms>           Delay between requests (default: 300)
  --deobf-depth <n>      Max deobfuscation passes (default: 5)
  --entropy <n>          Min secret entropy (default: 4.0)
  -f, --format <fmt>     Output format: json or jsonl (default: json)
  --no-chunks            Disable chunk discovery
  --no-files             Don't write JS files to disk
  --user-agent <str>     Custom User-Agent

{C.BOLD}{C.CYAN}BROWSER DISCOVERY (SPA_DOM):{C.RESET}
  {C.GREEN}--playwright{C.RESET}            Launch headless browser to capture dynamically-loaded JS
  {C.GREEN}--pw-browser{C.RESET} <engine>   chromium | firefox | webkit  (default: chromium)
  {C.GREEN}--pw-timeout{C.RESET} <ms>       Browser page load timeout      (default: 30000)
  {C.GREEN}--pw-pages{C.RESET} <n>          Max pages for Playwright        (default: 20)
  {C.GREEN}--pw-visible{C.RESET}            Show browser window (non-headless, useful for debugging)

  {C.DIM}First run: install browser binaries with:{C.RESET}
  {C.DIM}   npx playwright install chromium{C.RESET}

{C.BOLD}{C.CYAN}HISTORICAL DISCOVERY (Wayback):{C.RESET}
  {C.GREEN}--wayback{C.RESET}               Query Wayback Machine CDX for historical JS URLs
  {C.GREEN}--wb-results{C.RESET} <n>        Max CDX results per domain      (default: 200)
  {C.GREEN}--wb-max-age{C.RESET} <days>     Only fetch snapshots N days old max (0 = any age)

{C.BOLD}FULL COVERAGE EXAMPLE:{C.RESET}
  python run.py https://example.com --deep --playwright --wayback
""")
        sys.exit(0)

    # Build the command — never use shell=True (Windows cmd injection risk)
    npx_bin = "npx.cmd" if os.name == "nt" else "npx"
    cmd = [npx_bin, "ts-node", "src/index.ts"] + args

    start_time = datetime.now()

    try:
        result = subprocess.run(
            cmd,
            cwd=script_dir,
            shell=False,
        )

        duration = datetime.now() - start_time

        if result.returncode != 0:
            print(f"\n  {C.RED}{C.BOLD}[FAIL] Pipeline failed with exit code {result.returncode}{C.RESET}")
            sys.exit(result.returncode)

    except KeyboardInterrupt:
        print(f"\n\n  {C.YELLOW}Pipeline interrupted by user.{C.RESET}")
        sys.exit(130)
    except FileNotFoundError:
        print(f"\n  {C.RED}Error: npx not found. Make sure Node.js is installed.{C.RESET}")
        print(f"  {C.DIM}Install it from: https://nodejs.org{C.RESET}")
        sys.exit(1)


if __name__ == "__main__":
    main()
