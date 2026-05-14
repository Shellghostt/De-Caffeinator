// ============================================================
// STAGE 4 — UNICODE DECODER
// Walks the AST to find and decode encoded strings:
//   - Unicode escape sequences: \u0068\u0074\u0074\u0070 → "http"
//   - Hex escape sequences:     \x68\x65\x6c\x6c\x6f → "hello"
//   - Octal escapes:            \150\145\154\154\157 → "hello"
//   - Mixed encoded identifiers
//
// Unlike the constant folder (regex-based), this uses the
// Babel AST parser for accurate scope-aware decoding.
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export interface UnicodeDecodeResult {
  decoded: boolean;
  code: string;
  decodedCount: number;
}

export function decodeUnicode(code: string): UnicodeDecodeResult {
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript", "dynamicImport", "optionalChaining", "nullishCoalescingOperator"],
      errorRecovery: true,
    });
  } catch {
    return { decoded: false, code, decodedCount: 0 };
  }

  let decodedCount = 0;

  try {
    traverse(ast, {
      StringLiteral(path) {
        // Babel already decodes escape sequences during parsing.
        // If the raw value differs from the cooked value, it had escapes.
        const node = path.node;
        if (node.extra && typeof node.extra.raw === "string") {
          const raw = node.extra.raw as string;
          // Check if raw has escape sequences that Babel decoded
          if (raw.includes("\\x") || raw.includes("\\u") || raw.includes("\\0")) {
            // Mark the node to regenerate with decoded value
            delete node.extra;
            decodedCount++;
          }
        }
      },

      // Decode computed member expressions with encoded strings
      // e.g. obj["\x68\x65\x6c\x6c\x6f"] → obj["hello"] → obj.hello
      MemberExpression(path) {
        if (
          path.node.computed &&
          t.isStringLiteral(path.node.property) &&
          /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(path.node.property.value)
        ) {
          // Convert computed access to dot notation when safe
          path.node.computed = false;
          path.node.property = t.identifier(path.node.property.value);
          decodedCount++;
        }
      },

      // Resolve template literals with no expressions to string literals
      TemplateLiteral(path) {
        if (path.node.expressions.length === 0 && path.node.quasis.length === 1) {
          const value = path.node.quasis[0].value.cooked;
          if (value !== null && value !== undefined) {
            path.replaceWith(t.stringLiteral(value));
            decodedCount++;
          }
        }
      },
    });
  } catch {
    return { decoded: false, code, decodedCount: 0 };
  }

  if (decodedCount === 0) {
    return { decoded: false, code, decodedCount: 0 };
  }

  try {
    const output = generate(ast, {
      retainLines: false,
      compact: false,
      concise: false,
      comments: true,
    });
    return { decoded: true, code: output.code, decodedCount };
  } catch {
    return { decoded: false, code, decodedCount: 0 };
  }
}
