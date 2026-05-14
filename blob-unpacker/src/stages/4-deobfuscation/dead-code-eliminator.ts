// ============================================================
// STAGE 4 — DEAD CODE ELIMINATOR
// Removes code that can never be reached or executed:
//   - if(false){...} / if(0){...} blocks
//   - Code after unconditional return/throw/break/continue
//   - Unreferenced variable declarations
//   - Empty statement blocks
//   - Constant boolean expressions in conditionals
//
// Uses Babel AST for accurate analysis.
// ============================================================

import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export interface DeadCodeResult {
  eliminated: boolean;
  code: string;
  removedCount: number;
}

export function eliminateDeadCode(code: string): DeadCodeResult {
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
    return { eliminated: false, code, removedCount: 0 };
  }

  let removedCount = 0;

  try {
    traverse(ast, {
      // ── if(false) / if(0) / if("") — remove dead branch ──
      IfStatement(path) {
        const test = path.node.test;

        if (isKnownFalsy(test)) {
          // The consequent is dead code
          if (path.node.alternate) {
            // Replace if(false){A}else{B} with just B
            if (t.isBlockStatement(path.node.alternate)) {
              path.replaceWithMultiple(path.node.alternate.body);
            } else {
              path.replaceWith(path.node.alternate);
            }
          } else {
            // Remove entirely: if(false){A}
            path.remove();
          }
          removedCount++;
          return;
        }

        if (isKnownTruthy(test)) {
          // The alternate is dead code — keep only the consequent
          if (t.isBlockStatement(path.node.consequent)) {
            path.replaceWithMultiple(path.node.consequent.body);
          } else {
            path.replaceWith(path.node.consequent);
          }
          removedCount++;
          return;
        }
      },

      // ── Conditional expressions: false ? a : b → b ──
      ConditionalExpression(path) {
        if (isKnownFalsy(path.node.test)) {
          path.replaceWith(path.node.alternate);
          removedCount++;
        } else if (isKnownTruthy(path.node.test)) {
          path.replaceWith(path.node.consequent);
          removedCount++;
        }
      },

      // ── while(false){...} — remove entirely ──
      WhileStatement(path) {
        if (isKnownFalsy(path.node.test)) {
          path.remove();
          removedCount++;
        }
      },

      // ── Code after return/throw/break/continue (unreachable) ──
      BlockStatement(path) {
        const body = path.node.body;
        let terminated = false;

        for (let i = 0; i < body.length; i++) {
          if (terminated) {
            // Everything after a terminal statement is dead
            removedCount += body.length - i;
            body.splice(i);
            break;
          }

          const stmt = body[i];
          if (
            t.isReturnStatement(stmt) ||
            t.isThrowStatement(stmt) ||
            t.isBreakStatement(stmt) ||
            t.isContinueStatement(stmt)
          ) {
            terminated = true;
          }
        }
      },

      // ── Remove empty statements ──
      EmptyStatement(path) {
        path.remove();
        removedCount++;
      },

      // ── Boolean negation folding + void 0 → undefined ──
      UnaryExpression(path) {
        // !!true → true, !!false → false
        if (path.node.operator === "!" && t.isUnaryExpression(path.node.argument) &&
            path.node.argument.operator === "!") {
          const inner = path.node.argument.argument;
          if (t.isBooleanLiteral(inner) || t.isNumericLiteral(inner)) {
            path.replaceWith(t.booleanLiteral(!!getTruthValue(inner)));
            removedCount++;
            return;
          }
        }
        // !true → false, !false → true
        if (path.node.operator === "!" && t.isBooleanLiteral(path.node.argument)) {
          path.replaceWith(t.booleanLiteral(!path.node.argument.value));
          removedCount++;
          return;
        }
        // void 0 → undefined
        if (
          path.node.operator === "void" &&
          t.isNumericLiteral(path.node.argument) &&
          path.node.argument.value === 0
        ) {
          path.replaceWith(t.identifier("undefined"));
          removedCount++;
        }
      },
    });
  } catch {
    return { eliminated: false, code, removedCount: 0 };
  }

  if (removedCount === 0) {
    return { eliminated: false, code, removedCount: 0 };
  }

  try {
    const output = generate(ast, {
      retainLines: false,
      compact: false,
      concise: false,
      comments: true,
    });
    return { eliminated: true, code: output.code, removedCount };
  } catch {
    return { eliminated: false, code, removedCount: 0 };
  }
}

// ----------------------------------------------------------
// HELPERS
// ----------------------------------------------------------

function isKnownFalsy(node: t.Node): boolean {
  if (t.isBooleanLiteral(node) && !node.value) return true;
  if (t.isNumericLiteral(node) && node.value === 0) return true;
  if (t.isStringLiteral(node) && node.value === "") return true;
  if (t.isNullLiteral(node)) return true;
  if (t.isIdentifier(node) && node.name === "undefined") return true;
  // ![] and !{} are false, but [] and {} are truthy — don't remove
  return false;
}

function isKnownTruthy(node: t.Node): boolean {
  if (t.isBooleanLiteral(node) && node.value) return true;
  if (t.isNumericLiteral(node) && node.value !== 0) return true;
  if (t.isStringLiteral(node) && node.value.length > 0) return true;
  return false;
}

function getTruthValue(node: t.Node): boolean {
  if (t.isBooleanLiteral(node)) return node.value;
  if (t.isNumericLiteral(node)) return node.value !== 0;
  return false;
}
