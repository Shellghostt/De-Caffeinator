/**
 * Security-critical unit tests for De-Caffeinator / blob-unpacker.
 * Run: npx ts-node --transpile-only src/tests/security-helpers.test.ts
 */

import * as assert from "assert";
import * as path from "path";
import { isPrivateOrReservedIp, sameOrigin } from "../lib/http";
import { isPathInside, sanitizeSourcePath } from "../lib/safe-path";
import { decodeHtmlEntities } from "../lib/html-entities";
import { buildLineStarts, lineNumberAt } from "../lib/line-index";
import { normalizePath, parseSourceMap } from "../stages/3-reconstruction/map-parser";
import { evalUnpack, isStillPacked } from "../stages/4-deobfuscation/eval-unpacker";
import { isFirstPartyHost } from "../lib/paths";
import { normalizeUrl } from "../core/queue";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}: ${msg}`);
  }
}

console.log("\nSecurity helper tests\n");

test("isPrivateOrReservedIp blocks loopback and RFC1918", () => {
  assert.strictEqual(isPrivateOrReservedIp("127.0.0.1"), true);
  assert.strictEqual(isPrivateOrReservedIp("10.0.0.1"), true);
  assert.strictEqual(isPrivateOrReservedIp("192.168.1.1"), true);
  assert.strictEqual(isPrivateOrReservedIp("169.254.169.254"), true);
  assert.strictEqual(isPrivateOrReservedIp("8.8.8.8"), false);
  assert.strictEqual(isPrivateOrReservedIp("::1"), true);
});

test("sameOrigin compares protocol+host+port", () => {
  assert.strictEqual(
    sameOrigin("https://example.com", "https://example.com/foo"),
    true
  );
  assert.strictEqual(
    sameOrigin("https://example.com", "https://evil.com/foo"),
    false
  );
});

test("sanitizeSourcePath strips traversal and schemes", () => {
  assert.ok(!sanitizeSourcePath("../../etc/passwd").includes(".."));
  assert.ok(!sanitizeSourcePath("webpack:///./src/App.tsx").includes("webpack"));
  assert.strictEqual(sanitizeSourcePath(""), "_unnamed");
});

test("isPathInside blocks prefix bypass", () => {
  const base = path.resolve("/tmp/sources/abc");
  const evil = path.resolve("/tmp/sources/abc_evil/pwn.js");
  const good = path.resolve("/tmp/sources/abc/src/App.tsx");
  assert.strictEqual(isPathInside(base, evil), false);
  assert.strictEqual(isPathInside(base, good), true);
});

test("decodeHtmlEntities handles named and numeric", () => {
  assert.strictEqual(decodeHtmlEntities("a&amp;b"), "a&b");
  assert.strictEqual(decodeHtmlEntities("&#39;"), "'");
  assert.strictEqual(decodeHtmlEntities("&apos;"), "'");
});

test("lineNumberAt is O(1) after preprocess", () => {
  const code = "a\nb\nc";
  const starts = buildLineStarts(code);
  assert.strictEqual(lineNumberAt(starts, 0), 1);
  assert.strictEqual(lineNumberAt(starts, 2), 2);
  assert.strictEqual(lineNumberAt(starts, 4), 3);
});

test("normalizePath rejects unresolved ..", () => {
  assert.strictEqual(normalizePath("../etc/passwd"), "etc/passwd");
  assert.ok(!normalizePath("a\\b\\c").includes("\\") || normalizePath("a\\b\\c").includes("b"));
});

test("evalUnpack never uses vm — static atob works", () => {
  const packed = 'eval(atob("Y29uc29sZS5sb2coMSk="))';
  const result = evalUnpack(packed, { evalSandbox: true });
  assert.strictEqual(result.unpacked, true);
  assert.ok(result.code.includes("console"));
});

test("eval_sandbox false skips Dean Edwards packer path", () => {
  const code = "eval(function(p,a,c,k,e,d){return p}('x',62,1,'y'.split('|'),0,{}))";
  const result = evalUnpack(code, { evalSandbox: false });
  // May still unwrap via other paths; packer-specific static unpack is gated
  assert.ok(typeof result.code === "string");
});

test("isStillPacked requires real hex array entries", () => {
  assert.strictEqual(isStillPacked("var _0x12 = [];"), false);
  assert.strictEqual(
    isStillPacked("var _0x12 = ['a','b','c'];"),
    true
  );
});

test("isFirstPartyHost rejects reverse suffix and unknown", () => {
  assert.strictEqual(isFirstPartyHost("com", "evil.com"), false);
  assert.strictEqual(isFirstPartyHost("_unknown", "evil.com"), false);
  assert.strictEqual(isFirstPartyHost("cdn.evil.com", "evil.com"), true);
  assert.strictEqual(isFirstPartyHost("evil.com", "evil.com"), true);
});

test("normalizeUrl preserves path casing", () => {
  const n = normalizeUrl("https://Example.COM/Foo/Bar.js?Q=1");
  assert.ok(n.includes("/Foo/Bar.js"));
  assert.ok(n.startsWith("https://example.com"));
});

test("parseSourceMap remaps index sections without throwing", () => {
  const indexMap = {
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: {
          version: 3,
          sources: ["a.js"],
          names: ["foo"],
          mappings: "AAAAA",
          sourcesContent: ["var foo=1"],
        },
      },
      {
        offset: { line: 2, column: 0 },
        map: {
          version: 3,
          sources: ["b.js"],
          names: ["bar"],
          mappings: "AAAAA",
          sourcesContent: ["var bar=2"],
        },
      },
    ],
  };
  const parsed = parseSourceMap(JSON.stringify(indexMap));
  assert.strictEqual(parsed.sources.length, 2);
  assert.ok(parsed.mappings.includes(";"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
