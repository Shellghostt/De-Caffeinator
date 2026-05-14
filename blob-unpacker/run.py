#!/usr/bin/env python3
"""
Blob Unpacker - Interactive Launcher
Run this script to launch the full pipeline with an interactive menu.

Usage:
    python run.py
"""

import os
import sys
import json
import subprocess
from pathlib import Path
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

def clear():
    os.system("cls" if os.name == "nt" else "clear")

def banner():
    print(f"""
{C.CYAN}{C.BOLD}+==================================================================+
|                                                                  |
|    ____  _     ___  ____                                         |
|   | __ )| |   / _ \\| __ )                                        |
|   |  _ \\| |  | | | |  _ \\                                        |
|   | |_) | |__| |_| | |_) |                                       |
|   |____/|_____\\___/|____/                                        |
|           _   _ _   _ ____   _    ____ _  _______ ____           |
|          | | | | \\ | |  _ \\ / \\  / ___| |/ / ____|  _ \\          |
|          | | | |  \\| | |_) / _ \\| |   | ' /|  _| | |_) |         |
|          | |_| | |\\  |  __/ ___ \\ |___| . \\| |___|  _ <          |
|           \\___/|_| \\_|_| /_/   \\_\\____|_|\\_\\_____|_| \\_\\         |
|                                                                  |
|        JavaScript Reverse Engineering & Asset Analysis           |
+==================================================================+{C.RESET}
""")

def print_section(title):
    print(f"\n{C.CYAN}{C.BOLD}{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}{C.RESET}\n")

def print_option(num, label, desc=""):
    if desc:
        print(f"  {C.GREEN}{C.BOLD}[{num}]{C.RESET} {label} {C.DIM}-- {desc}{C.RESET}")
    else:
        print(f"  {C.GREEN}{C.BOLD}[{num}]{C.RESET} {label}")

def prompt(msg, default=""):
    if default:
        val = input(f"  {C.YELLOW}>{C.RESET} {msg} {C.DIM}(default: {default}){C.RESET}: ").strip()
        return val if val else default
    return input(f"  {C.YELLOW}>{C.RESET} {msg}: ").strip()

def prompt_yn(msg, default=True):
    d = "Y/n" if default else "y/N"
    val = input(f"  {C.YELLOW}>{C.RESET} {msg} [{d}]: ").strip().lower()
    if not val:
        return default
    return val in ("y", "yes")

# ── Presets ─────────────────────────────────────────────────

PRESETS = {
    "1": {
        "name": "FULL POWER (Recommended)",
        "desc": "Maximum coverage -- deep crawl, all techniques, chunk discovery on",
        "args": {
            "depth": "3",
            "pages": "100",
            "concurrency": "5",
            "timeout": "20000",
            "delay": "300",
            "deobf_depth": "5",
            "entropy": "4.0",
            "format": "json",
            "chunks": True,
            "files": True,
        }
    },
    "2": {
        "name": "QUICK SCAN",
        "desc": "Fast scan of the entry page only -- good for initial recon",
        "args": {
            "depth": "0",
            "pages": "1",
            "concurrency": "3",
            "timeout": "10000",
            "delay": "200",
            "deobf_depth": "3",
            "entropy": "4.5",
            "format": "json",
            "chunks": False,
            "files": True,
        }
    },
    "3": {
        "name": "DEEP RECON",
        "desc": "Very deep crawl for large SPAs -- finds every hidden chunk",
        "args": {
            "depth": "5",
            "pages": "200",
            "concurrency": "3",
            "timeout": "30000",
            "delay": "500",
            "deobf_depth": "5",
            "entropy": "3.5",
            "format": "json",
            "chunks": True,
            "files": True,
        }
    },
    "4": {
        "name": "STEALTH MODE",
        "desc": "Low concurrency, high delays -- avoids rate limiting & detection",
        "args": {
            "depth": "2",
            "pages": "50",
            "concurrency": "1",
            "timeout": "30000",
            "delay": "2000",
            "deobf_depth": "5",
            "entropy": "4.5",
            "format": "json",
            "chunks": True,
            "files": True,
        }
    },
    "5": {
        "name": "CUSTOM CONFIGURATION",
        "desc": "Configure every parameter manually",
        "args": None,
    }
}

def get_custom_config():
    """Interactive custom configuration."""
    print_section("Custom Configuration")
    args = {}

    print(f"  {C.BOLD}Crawl Settings:{C.RESET}")
    args["depth"]       = prompt("Crawl depth (0=entry page only, 3=recommended)", "3")
    args["pages"]       = prompt("Max pages to crawl", "100")
    args["chunks"]      = prompt_yn("Enable dynamic chunk discovery (import(), webpack)?", True)

    print(f"\n  {C.BOLD}HTTP Settings:{C.RESET}")
    args["concurrency"] = prompt("Max concurrent requests", "5")
    args["timeout"]     = prompt("Request timeout (ms)", "20000")
    args["delay"]       = prompt("Delay between requests (ms)", "300")

    print(f"\n  {C.BOLD}Analysis Settings:{C.RESET}")
    args["deobf_depth"] = prompt("Max de-obfuscation passes", "5")
    args["entropy"]     = prompt("Min entropy for secret detection (lower=more results)", "4.0")

    print(f"\n  {C.BOLD}Output Settings:{C.RESET}")
    args["format"]      = prompt("Output format (json/jsonl)", "json")
    args["files"]       = prompt_yn("Write source files & deobfuscated JS to disk?", True)

    return args

def build_command(url, output_dir, args):
    """Build the ts-node command from config."""
    cmd = ["npx", "ts-node", "src/index.ts", url]

    cmd.extend(["-o", output_dir])
    cmd.extend(["-d", args["depth"]])
    cmd.extend(["-p", args["pages"]])
    cmd.extend(["-c", args["concurrency"]])
    cmd.extend(["-t", args["timeout"]])
    cmd.extend(["--delay", args["delay"]])
    cmd.extend(["--deobf-depth", args["deobf_depth"]])
    cmd.extend(["--entropy", args["entropy"]])
    cmd.extend(["-f", args["format"]])

    if not args.get("chunks", True):
        cmd.append("--no-chunks")
    if not args.get("files", True):
        cmd.append("--no-files")

    return cmd

def show_results(output_dir):
    """Display results summary after pipeline completes."""
    print_section("Pipeline Results")

    # Show run report
    report_path = os.path.join(output_dir, "run-report.json")
    if os.path.exists(report_path):
        with open(report_path, "r", encoding="utf-8") as f:
            report = json.load(f)

        print(f"  {C.BOLD}Processing Stats:{C.RESET}")
        print(f"    Total assets processed:  {C.GREEN}{report.get('total_assets', 0)}{C.RESET}")
        print(f"    Successfully completed:  {C.GREEN}{report.get('successfully_processed', 0)}{C.RESET}")
        print(f"    Failed:                  {C.RED}{report.get('failed_assets', 0)}{C.RESET}")
        print()

    # Show finding counts
    for name, filename in [("Endpoints", "endpoints"), ("Secrets", "secrets"),
                            ("Comments", "comments"), ("Configs", "configs")]:
        fpath = os.path.join(output_dir, f"{filename}.json")
        if os.path.exists(fpath):
            with open(fpath, "r", encoding="utf-8") as f:
                data = json.load(f)
            count = len(data) if isinstance(data, list) else 0
            color = C.GREEN if count > 0 else C.DIM
            marker = "[+]" if count > 0 else "[-]"
            print(f"    {marker} {name}: {color}{count}{C.RESET}")

    print()

    # Show output files
    print(f"  {C.BOLD}Output Files:{C.RESET}")
    for item in sorted(os.listdir(output_dir)):
        full = os.path.join(output_dir, item)
        if os.path.isfile(full):
            size = os.path.getsize(full)
            size_str = format_size(size)
            print(f"    [F] {item} {C.DIM}({size_str}){C.RESET}")
        elif os.path.isdir(full):
            count = sum(1 for _ in Path(full).rglob("*") if _.is_file())
            print(f"    [D] {item}/ {C.DIM}({count} files){C.RESET}")

    summary_path = os.path.join(output_dir, "summary.md")
    if os.path.exists(summary_path):
        abs_path = os.path.abspath(summary_path)
        print(f"\n  {C.CYAN}{C.BOLD}>> Full report: {abs_path}{C.RESET}")

def format_size(size):
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.0f}{unit}" if unit == "B" else f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}TB"

def show_capabilities():
    """Show what the pipeline can do."""
    print_section("What Blob Unpacker Can Do")

    capabilities = [
        ("STAGE 1 - Asset Discovery", [
            "Crawl websites and discover all JavaScript files",
            "Follow links across multiple pages (SPA-aware)",
            "Detect dynamically loaded chunks (import(), webpack, Vite)",
            "Find inline scripts, vendor bundles, and code-split chunks",
        ]),
        ("STAGE 2 - Source Map Detection", [
            "Find //# sourceMappingURL comments in JS files",
            "Probe common .map file paths (/sourcemaps/, /maps/)",
            "Check SourceMap HTTP headers",
            "Handle inline base64 data URI source maps",
        ]),
        ("STAGE 3 - Source Reconstruction", [
            "Rebuild original project source from source maps",
            "Reconstruct full directory tree (src/, components/, etc.)",
            "Recover original file names and paths",
            "Partial reconstruction when sourcesContent is missing",
            "VLQ-based code fragment extraction",
            "Original variable name recovery",
        ]),
        ("STAGE 4 - De-obfuscation (9 techniques)", [
            "Beautify minified JavaScript",
            "Unpack eval() / Dean Edwards packed code",
            "Resolve string array obfuscation (_0x patterns)",
            "Resolve hex function calls (_0xabc('0x1f'))",
            "Decode unicode/hex escape sequences (AST-based)",
            'Fold constant expressions ("a"+"b" -> "ab")',
            "Eliminate dead code (if(false), unreachable blocks)",
            "Unflatten control flow (switch-case state machines)",
            "Split Webpack/Rollup/Vite/Turbopack/Parcel bundles",
        ]),
        ("STAGE 5 - Artifact Extraction (regex + AST)", [
            "API endpoints (fetch, axios, XHR, route definitions)",
            "Internal/admin/debug/hidden routes with classification",
            "Hardcoded URLs (https, wss, IP:port)",
            "Secrets: AWS, Firebase, Stripe, GitHub, Slack, JWT, etc.",
            "Developer comments (TODO, FIXME, HACK, bypass, debug)",
            "Config objects, feature flags, env variables",
            "Third-party configs (Sentry, Auth0, Supabase, Pusher, etc.)",
        ]),
        ("STAGE 6 - Output", [
            "JSON/JSONL structured data files",
            "Human-readable summary report (Markdown)",
            "Versioned contracts for downstream tools (Source Auditor)",
            "Reconstructed source files on disk",
            "Beautified de-obfuscated JS files",
            "Full pipeline execution log",
        ]),
    ]

    for title, items in capabilities:
        print(f"  {C.BOLD}{title}{C.RESET}")
        for item in items:
            print(f"    {C.DIM}-{C.RESET} {item}")
        print()

# ── Main ────────────────────────────────────────────────────

def main():
    # Ensure we're in the right directory
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    if not os.path.exists("src/index.ts"):
        print(f"{C.RED}Error: src/index.ts not found. Run this from the blob-unpacker directory.{C.RESET}")
        sys.exit(1)

    clear()
    banner()

    # ── Main Menu ──────────────────────────────────────────
    print_section("What would you like to do?")
    print_option("1", "Run the pipeline", "Analyze a target URL")
    print_option("2", "View capabilities", "See everything this tool can do")
    print_option("3", "View last results", "Open results from a previous run")
    print_option("0", "Exit")
    print()

    choice = prompt("Select an option", "1")

    if choice == "0":
        print(f"\n  {C.DIM}Goodbye!{C.RESET}\n")
        sys.exit(0)

    if choice == "2":
        show_capabilities()
        input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        main()
        return

    if choice == "3":
        output_dir = prompt("Output directory to view", "./output")
        if os.path.exists(output_dir):
            show_results(output_dir)
        else:
            print(f"\n  {C.RED}Directory not found: {output_dir}{C.RESET}")
        return

    # ── Run Pipeline ───────────────────────────────────────
    print_section("Target")
    url = prompt("Enter the target URL (e.g. https://example.com)")

    if not url:
        print(f"\n  {C.RED}No URL provided. Exiting.{C.RESET}")
        sys.exit(1)

    if not url.startswith("http"):
        url = "https://" + url

    # Output directory
    output_dir = prompt("Output directory", "./output")

    # ── Preset Selection ───────────────────────────────────
    print_section("Scan Profile")
    for key, preset in PRESETS.items():
        star = f" {C.YELLOW}*{C.RESET}" if key == "1" else ""
        print_option(key, preset["name"] + star, preset["desc"])
    print()

    preset_choice = prompt("Select a profile", "1")
    preset = PRESETS.get(preset_choice, PRESETS["1"])

    if preset["args"] is None:
        args = get_custom_config()
    else:
        args = preset["args"]

    # ── Confirmation ───────────────────────────────────────
    print_section("Launch Configuration")
    print(f"  {C.BOLD}Target:{C.RESET}          {C.CYAN}{url}{C.RESET}")
    print(f"  {C.BOLD}Profile:{C.RESET}         {preset['name']}")
    print(f"  {C.BOLD}Output:{C.RESET}          {output_dir}")
    print(f"  {C.BOLD}Crawl depth:{C.RESET}     {args['depth']}")
    print(f"  {C.BOLD}Max pages:{C.RESET}       {args['pages']}")
    print(f"  {C.BOLD}Concurrency:{C.RESET}     {args['concurrency']}")
    print(f"  {C.BOLD}Timeout:{C.RESET}         {args['timeout']}ms")
    print(f"  {C.BOLD}Delay:{C.RESET}           {args['delay']}ms")
    print(f"  {C.BOLD}Deobf passes:{C.RESET}    {args['deobf_depth']}")
    print(f"  {C.BOLD}Min entropy:{C.RESET}     {args['entropy']}")
    print(f"  {C.BOLD}Chunk discovery:{C.RESET} {'Yes' if args.get('chunks', True) else 'No'}")
    print(f"  {C.BOLD}Write files:{C.RESET}     {'Yes' if args.get('files', True) else 'No'}")
    print(f"  {C.BOLD}Format:{C.RESET}          {args['format']}")
    print()

    if not prompt_yn("Launch the pipeline?", True):
        print(f"\n  {C.DIM}Cancelled.{C.RESET}\n")
        return

    # ── Build & Run ────────────────────────────────────────
    cmd = build_command(url, output_dir, args)

    print_section("Running Pipeline")
    print(f"  {C.DIM}Command: {' '.join(cmd)}{C.RESET}\n")

    start_time = datetime.now()

    try:
        result = subprocess.run(
            cmd,
            cwd=script_dir,
            shell=(os.name == "nt"),
        )

        duration = datetime.now() - start_time

        if result.returncode == 0:
            print(f"\n  {C.GREEN}{C.BOLD}[OK] Pipeline completed successfully in {duration.total_seconds():.1f}s{C.RESET}")
            show_results(output_dir)
        else:
            print(f"\n  {C.RED}{C.BOLD}[FAIL] Pipeline failed with exit code {result.returncode}{C.RESET}")

    except KeyboardInterrupt:
        print(f"\n\n  {C.YELLOW}Pipeline interrupted by user.{C.RESET}")
        if os.path.exists(output_dir):
            print(f"  {C.DIM}Partial results may be available in {output_dir}{C.RESET}")
    except FileNotFoundError:
        print(f"\n  {C.RED}Error: npx not found. Make sure Node.js is installed.{C.RESET}")
        print(f"  {C.DIM}Install it from: https://nodejs.org{C.RESET}")

if __name__ == "__main__":
    main()
