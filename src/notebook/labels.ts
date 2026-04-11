/**
 * Label rewriting for Maxima notebook cells.
 *
 * Port of aximar-core/src/maxima/labels.rs. Two-step algorithm:
 * 1. Replace display %oN / %iN labels using labelMap
 * 2. Replace bare % with previousOutputLabel
 *
 * Step 1 runs first on the original input; step 2 runs on the result.
 * This prevents double-rewriting where bare % expands to e.g. %o6 and
 * then the display label regex re-matches it.
 */

import type { LabelContext } from "./types";

const DISPLAY_LABEL_RE = /%([oi])(\d+)/g;

/**
 * Rewrite label references in a Maxima expression.
 */
export function rewriteLabels(input: string, ctx: LabelContext): string {
  // Step 1: replace display %oN / %iN
  const afterDisplay = input.replace(DISPLAY_LABEL_RE, (match, kind: string, numStr: string) => {
    const num = parseInt(numStr, 10);
    const realLabel = ctx.labelMap.get(num);
    if (realLabel) {
      // Extract the number from the real label (e.g. "%o6" → "6")
      const realNum = realLabel.replace(/^%o/, "");
      return `%${kind}${realNum}`;
    }
    return match;
  });

  // Step 2: replace bare %
  if (ctx.previousOutputLabel !== undefined) {
    return replaceBarePercent(afterDisplay, ctx.previousOutputLabel);
  }
  return afterDisplay;
}

/**
 * Replace bare `%` (not followed by `%`, letter, digit, or `_`) with replacement.
 * Character-by-character loop matching the Rust implementation.
 */
function replaceBarePercent(input: string, replacement: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "%") {
      const next = i + 1 < input.length ? input[i + 1] : undefined;
      if (next === "%") {
        // %% is a Maxima construct — emit both and skip past
        result += "%%";
        i += 2;
      } else if (next !== undefined && isIdentChar(next)) {
        // Followed by letter, digit, or underscore — not bare
        result += "%";
        i += 1;
      } else {
        // Bare % (followed by non-identifier char or end of string)
        result += replacement;
        i += 1;
      }
    } else {
      result += input[i];
      i += 1;
    }
  }
  return result;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}
