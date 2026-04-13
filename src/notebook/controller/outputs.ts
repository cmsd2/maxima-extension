/**
 * Output building: convert EvalResult to VS Code notebook outputs.
 */

import * as vscode from "vscode";
import type { EvalResult } from "../types";

/** Convert an evaluation result to notebook cell outputs. */
export function buildOutputs(result: EvalResult): vscode.NotebookCellOutput[] {
  if (result.is_error) {
    const message = result.error || result.text_output || "Evaluation error";
    return [
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(new Error(message)),
      ]),
    ];
  }

  const outputs: vscode.NotebookCellOutput[] = [];

  // Text output from print()/tex() side effects — shown as plain text
  if (result.text_output) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.text_output,
          "text/plain",
        ),
      ]),
    );
  }

  // Final result as LaTeX (from injected tex(%))
  if (result.latex) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.latex,
          "application/x-maxima-latex",
        ),
      ]),
    );
  }

  // SVG plot — renders natively in VS Code
  if (result.plot_svg) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.plot_svg,
          "image/svg+xml",
        ),
      ]),
    );
  }

  // Plotly data — interactive chart via custom renderer
  if (result.plot_data) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.plot_data,
          "application/x-maxima-plotly",
        ),
        vscode.NotebookCellOutputItem.text(result.plot_data, "text/plain"),
      ]),
    );
  }

  return outputs;
}

/** Race a promise against a timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
