// ============================================================
// STAGE 4 — CONTROL FLOW UNFLATTENER
// Detects and reverses the control flow flattening obfuscation
// technique where the original code's linear flow is replaced
// with a switch-case state machine driven by a string sequence.
//
// Pattern (before):
//   var _0x = "3|1|4|0|2".split("|"), _0xi = 0;
//   while(true) {
//     switch(_0x[_0xi++]) {
//       case "0": ...; continue;
//       case "1": ...; continue;
//       case "2": ...; break;
//       case "3": ...; continue;
//       case "4": ...; continue;
//     }
//     break;
//   }
//
// Pattern (after):
//   /* case 3 */ ...;
//   /* case 1 */ ...;
//   /* case 4 */ ...;
//   /* case 0 */ ...;
//   /* case 2 */ ...;
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export interface UnflattenResult {
  unflattened: boolean;
  code: string;
  patternsFound: number;
}

export function unflattenControlFlow(code: string): UnflattenResult {
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
    return { unflattened: false, code, patternsFound: 0 };
  }

  let patternsFound = 0;

  try {
    traverse(ast, {
      WhileStatement(path) {
        // Check for while(true) or while(1) or while(!![])
        if (!isAlwaysTrue(path.node.test)) return;

        const body = path.node.body;
        if (!t.isBlockStatement(body)) return;

        // Find the switch statement inside
        const switchIdx = body.body.findIndex((s) => t.isSwitchStatement(s));
        if (switchIdx === -1) return;
        const switchStmt = body.body[switchIdx] as t.SwitchStatement;

        // Check if the discriminant is an array access pattern: arr[idx++]
        const orderInfo = extractOrderInfo(path, switchStmt);
        if (!orderInfo) return;

        // Reorder the cases according to the sequence
        const orderedStatements = reorderCases(switchStmt, orderInfo.sequence);
        if (orderedStatements.length === 0) return;

        // Replace the while loop with the ordered statements
        path.replaceWithMultiple(orderedStatements);
        patternsFound++;
      },
    });
  } catch {
    return { unflattened: false, code, patternsFound: 0 };
  }

  if (patternsFound === 0) {
    return { unflattened: false, code, patternsFound: 0 };
  }

  try {
    const output = generate(ast, {
      retainLines: false,
      compact: false,
      concise: false,
      comments: true,
    });
    return { unflattened: true, code: output.code, patternsFound };
  } catch {
    return { unflattened: false, code, patternsFound: 0 };
  }
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

interface OrderInfo {
  sequence: string[];
}

function isAlwaysTrue(node: t.Node): boolean {
  if (t.isBooleanLiteral(node) && node.value) return true;
  if (t.isNumericLiteral(node) && node.value !== 0) return true;
  // !![] pattern
  if (
    t.isUnaryExpression(node) &&
    node.operator === "!" &&
    t.isUnaryExpression(node.argument) &&
    node.argument.operator === "!"
  ) return true;
  return false;
}

/**
 * Extract the execution order from the control flow flattening setup.
 * Looks for patterns like:
 *   var _0x = "3|1|4|0|2".split("|")
 *   var _0xi = 0
 *   switch(_0x[_0xi++])
 */
function extractOrderInfo(
  whilePath: any,
  switchStmt: t.SwitchStatement
): OrderInfo | null {
  // Strategy 1: Look for "N|N|N".split("|") in the same block or parent scope
  const parent = whilePath.parentPath;
  if (!parent || !t.isBlockStatement(parent.node) && !t.isProgram(parent.node)) {
    return null;
  }

  const siblings = (parent.node as any).body as t.Statement[];
  if (!Array.isArray(siblings)) return null;

  // Find the split pattern
  for (const sibling of siblings) {
    if (!t.isVariableDeclaration(sibling)) continue;
    for (const decl of sibling.declarations) {
      if (!t.isVariableDeclarator(decl) || !decl.init) continue;

      // "3|1|4|0|2".split("|")
      if (
        t.isCallExpression(decl.init) &&
        t.isMemberExpression(decl.init.callee) &&
        t.isStringLiteral(decl.init.callee.object) &&
        t.isIdentifier(decl.init.callee.property) &&
        decl.init.callee.property.name === "split" &&
        decl.init.arguments.length === 1 &&
        t.isStringLiteral(decl.init.arguments[0]) &&
        decl.init.arguments[0].value === "|"
      ) {
        const sequence = decl.init.callee.object.value.split("|");
        if (sequence.length >= 2) {
          return { sequence };
        }
      }
    }
  }

  // Strategy 2: Inline pattern — switch(arr[idx++]) where arr is defined nearby
  // Check the switch discriminant
  if (
    t.isMemberExpression(switchStmt.discriminant) &&
    t.isIdentifier(switchStmt.discriminant.object)
  ) {
    const arrName = switchStmt.discriminant.object.name;

    for (const sibling of siblings) {
      if (!t.isVariableDeclaration(sibling)) continue;
      for (const decl of sibling.declarations) {
        if (
          t.isVariableDeclarator(decl) &&
          t.isIdentifier(decl.id) &&
          decl.id.name === arrName &&
          decl.init
        ) {
          // Direct array literal
          if (t.isArrayExpression(decl.init)) {
            const sequence = decl.init.elements
              .filter((el): el is t.StringLiteral => t.isStringLiteral(el))
              .map((el) => el.value);
            if (sequence.length >= 2) {
              return { sequence };
            }
          }
        }
      }
    }
  }

  return null;
}

function reorderCases(
  switchStmt: t.SwitchStatement,
  sequence: string[]
): t.Statement[] {
  // Build a map of case value → case body statements
  const caseMap = new Map<string, t.Statement[]>();

  for (const c of switchStmt.cases) {
    if (!c.test || !t.isStringLiteral(c.test)) continue;

    // Filter out 'continue' and 'break' — they're control flow artifacts
    const body = c.consequent.filter(
      (s) => !t.isContinueStatement(s) && !t.isBreakStatement(s)
    );
    caseMap.set(c.test.value, body);
  }

  // Reorder according to the sequence
  const result: t.Statement[] = [];
  for (const key of sequence) {
    const body = caseMap.get(key);
    if (body && body.length > 0) {
      result.push(...body);
    }
  }

  return result;
}
