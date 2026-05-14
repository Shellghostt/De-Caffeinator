// ============================================================
// STAGE 4 — BEAUTIFIER
// Formats minified JS using js-beautify.
// First pass applied to all assets — restores structure
// even when variable names remain short.
// ============================================================

import { js as beautify } from "js-beautify";

const BEAUTIFY_OPTIONS = {
  indent_size: 2,
  indent_char: " ",
  max_preserve_newlines: 2,
  preserve_newlines: true,
  keep_array_indentation: false,
  break_chained_methods: false,
  space_before_conditional: true,
  unescape_strings: true,
  jslint_happy: false,
  end_with_newline: true,
  wrap_line_length: 0,
  comma_first: false,
  operator_position: "before-newline" as const,
};

export function beautifyJs(code: string): string {
  try {
    return beautify(code, BEAUTIFY_OPTIONS);
  } catch {
    // If beautifier fails, return as-is — don't break the pipeline
    return code;
  }
}
