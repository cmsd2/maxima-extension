# Notebook Integration

VS Code Notebook API integration for running Maxima `.ipynb` notebooks.

## Components

The notebook feature has three VS Code API components:

1. **NotebookSerializer** — reads/writes `.ipynb` files
2. **NotebookController** — handles cell execution via aximar-mcp
3. **NotebookRenderer** — renders rich output (KaTeX, Plotly, SVG)

These are registered in `package.json` under the `maxima-notebook` notebook
type with `priority: "option"`, meaning VS Code offers it as an alternative
handler for `.ipynb` files alongside the Jupyter extension.

## NotebookSerializer

**File:** `src/notebook/serializer.ts`

Converts between Jupyter's `.ipynb` JSON format and VS Code's `NotebookData`.

### Deserialization (file → editor)

1. Parse JSON into `IpynbNotebook` structure
2. Map each `IpynbCell` to `NotebookCellData`:
   - `cell_type: "code"` → `NotebookCellKind.Code` with `languageId: "maxima"`
   - `cell_type: "markdown"` → `NotebookCellKind.Markup` with `languageId: "markdown"`
   - `cell_type: "raw"` → filtered out
3. Restore outputs from `outputs[].data` MIME bundles:
   - `text/latex` in ipynb → `application/x-maxima-latex` in VS Code
   - `application/x-maxima-plotly` preserved as-is
   - `image/svg+xml`, `text/plain` preserved as-is
4. Restore `execution_count` into `executionSummary`
5. If file is empty or invalid, return a single empty code cell

### Serialization (editor → file)

1. Map each `NotebookCellData` back to `IpynbCell`
2. Split cell source by newlines (ipynb stores source as `string[]`)
3. Map MIME types back to ipynb conventions:
   - `application/x-maxima-latex` → `text/latex` for Aximar/Jupyter compat
4. Always include `text/plain` fallback in output data
5. Write metadata with kernel spec:
   ```json
   {
     "kernelspec": {
       "name": "maxima",
       "display_name": "Maxima",
       "language": "maxima"
     }
   }
   ```
6. Preserve `metadata.aximar` if present (template_id, title, description)

### ipynb Format Reference

The `.ipynb` format matches Aximar's implementation in
`aximar-core/src/notebooks/types.rs`:

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": { "name": "maxima", "display_name": "Maxima", "language": "maxima" },
    "aximar": { "template_id": null, "title": null, "description": null }
  },
  "cells": [
    {
      "cell_type": "code",
      "source": ["integrate(x^2, x);"],
      "metadata": {},
      "execution_count": 1,
      "outputs": [
        {
          "output_type": "execute_result",
          "data": {
            "text/plain": "x^3/3",
            "text/latex": "{{x^3}\\over{3}}"
          },
          "metadata": {},
          "execution_count": 1
        }
      ]
    }
  ]
}
```

## NotebookController

**File:** `src/notebook/controller.ts`

Manages cell execution by communicating with aximar-mcp.

### Registration

```typescript
const controller = vscode.notebooks.createNotebookController(
  "maxima-notebook-controller",
  "maxima-notebook",
  "Maxima"
);
controller.supportedLanguages = ["maxima"];
controller.supportsExecutionOrder = true;
controller.executeHandler = executeCells;
controller.interruptHandler = interruptExecution;
```

### Cell Execution Flow

Cells are executed **sequentially** (Maxima is stateful — each cell builds
on the previous state).

1. **Create execution** — `controller.createNotebookCellExecution(cell)`
2. **Increment execution order** — local counter (not from Maxima)
3. **Label rewriting** — see [Label Rewriting](#label-rewriting) below
4. **Call MCP** — `mcpClient.evaluateExpression(rewrittenSource, notebookId)`
5. **Map outputs** — see [Output Mapping](#output-mapping) below
6. **Record label** — store returned `output_label` in cell metadata
7. **Complete execution** — `execution.end(success, timestamp)`

### Output Mapping

The `evaluate_expression` MCP tool returns:

```typescript
interface EvalResult {
  text_output: string;
  latex?: string | null;
  plot_svg?: string | null;
  plot_data?: string | null;
  error?: string | null;
  is_error: boolean;
  duration_ms: number;
  output_label?: string | null;
}
```

These fields map to VS Code notebook outputs:

| Field | Condition | MIME Type | Renderer |
|-------|-----------|-----------|----------|
| `error` | `is_error === true` | error output | Native VS Code |
| `text_output` | Non-empty, separate from result | `text/plain` | Native |
| `latex` | Present | `application/x-maxima-latex` | Custom (KaTeX) |
| `plot_svg` | Present | `image/svg+xml` | Native |
| `plot_data` | Present | `application/x-maxima-plotly` | Custom (Plotly) |

When a cell produces multiple output types (e.g., both LaTeX and a plot),
they are placed in separate `NotebookCellOutput` objects so they render
as distinct output blocks.

Text output (`print()` statements, warnings, provisos) renders above the
main result, mimicking Jupyter behavior.

### Interrupt / Restart

- **Interrupt**: Calls `restartSession(notebookId)` on aximar-mcp. This
  kills the current Maxima process and starts a fresh one. (Maxima does not
  reliably support mid-evaluation interrupts.)
- **Restart Kernel**: Same mechanism. Clears the label map and resets
  execution counter. Available as a toolbar button.

### Cell Metadata

The controller stores per-cell metadata for label tracking:

```typescript
interface MaximaCellMetadata {
  outputLabel?: string;      // Real Maxima label, e.g. "%o6"
  executionCount?: number;   // Display execution count (1, 2, 3...)
}
```

This metadata is preserved in the cell's `metadata` field and persisted
when the notebook is saved.

## Label Rewriting

**File:** `src/notebook/labels.ts`

Maxima's `%` symbol refers to the last computed result. In a raw Maxima
session, this is temporal — `%` means "the result I computed most recently."
In a notebook, users expect `%` to mean "the output of the cell above,"
regardless of the order in which cells were executed.

Aximar's `evaluate_cell` in `aximar-core/src/evaluation.rs` handles this by
rewriting labels before sending code to Maxima. Since we use
`evaluate_expression` (which does no label rewriting), we port this logic
to TypeScript.

### How It Works

**Context:** The controller maintains:
- `labelMap: Map<number, string>` — maps display execution count → real
  Maxima label (e.g., `1 → "%o6"`, `2 → "%o10"`)
- Per-cell `outputLabel` in metadata

**Before each execution:**

1. Walk backwards through notebook cells from the current cell
2. Find the first cell above with a non-null `outputLabel` →
   `previousOutputLabel`
3. Build `LabelContext { labelMap, previousOutputLabel }`
4. Call `rewriteLabels(cellSource, context)`

**The `rewriteLabels` function** (ported from
`aximar-core/src/maxima/labels.rs`):

1. **Step 1: Replace display `%oN`/`%iN`** — If cell source contains
   `%o1`, and `labelMap` has `1 → "%o6"`, rewrite to `%o6`. This lets
   users reference outputs by display order.
2. **Step 2: Replace bare `%`** — Replace `%` (not followed by a letter,
   digit, or underscore) with `previousOutputLabel`. This makes `%` refer
   to the cell above, not the last-executed cell.

**After execution:**

Record the returned `output_label` (e.g., `"%o6"`) in the cell's metadata
and in the `labelMap` under the current display execution count.

### Special Forms Preserved

The rewriter does NOT touch:
- `%e`, `%pi`, `%i`, `%phi`, `%gamma` — Maxima constants
- `%th(n)` — Maxima's "nth previous result" function
- `%%` — Maxima's special form
- `%_var` — User variables starting with `%`

### Example

Notebook has three cells:

| Cell | Source | Display Count | Real Label |
|------|--------|---------------|------------|
| 1 | `x^2 + 1;` | 1 | `%o3` |
| 2 | `diff(%, x);` | 2 | `%o7` |
| 3 | `%o1 + %o2;` | — | — |

When cell 2 executes:
- `previousOutputLabel` = `%o3` (cell 1's output)
- `diff(%, x)` → `diff(%o3, x)` (bare `%` → previous cell's label)

When cell 3 executes:
- `labelMap` = `{1: "%o3", 2: "%o7"}`
- `%o1 + %o2` → `%o3 + %o7` (display labels → real labels)

### Unicode Translation

`evaluate_expression` in aximar-mcp already calls `unicode_to_maxima()`
(converting Unicode Greek letters to Maxima identifiers). This does NOT
need to be duplicated in the extension.

## Notebook Type Registration

```json
{
  "contributes": {
    "notebooks": [{
      "type": "maxima-notebook",
      "displayName": "Maxima Notebook",
      "selector": [{ "filenamePattern": "*.ipynb" }],
      "priority": "option"
    }]
  }
}
```

**`priority: "option"`** means VS Code shows this as an alternative handler.
When opening an `.ipynb` file, the user can choose between the Jupyter
extension (if installed) and the Maxima extension. Users can set
`workbench.editorAssociations` to prefer Maxima for specific files or
folders:

```json
{
  "workbench.editorAssociations": {
    "*.ipynb": "maxima-notebook"
  }
}
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxima.notebook.mcpPath` | string | `""` | Path to aximar-mcp binary. Searches PATH if empty. |
| `maxima.notebook.evalTimeout` | number | `60` | Cell evaluation timeout in seconds. |

## LSP in Notebook Cells

The LSP client's `documentSelector` includes:

```typescript
{ scheme: "vscode-notebook-cell", language: "maxima" }
```

This enables completions, hover, diagnostics, and signature help inside
notebook code cells. Each cell is a separate document to the LSP.

**Limitation:** Cross-cell references don't work. A function `f(x)` defined
in cell 1 is not visible to the LSP when editing cell 3, because the LSP
sees each cell as an independent document. Maxima's 2500+ built-in functions
still complete correctly. A future improvement could implement
concat-document middleware to virtually stitch cells for the LSP.

## Toolbar and Commands

| Command | Title | Location |
|---------|-------|----------|
| `maxima.notebook.restartKernel` | Restart Kernel | Notebook toolbar |
| `maxima.notebook.interruptKernel` | Interrupt Kernel | Command palette |
| `maxima.notebook.debugNotebook` | Debug Notebook | Notebook toolbar |
| `maxima.notebook.debugFromCell` | Debug From This Cell | Cell title menu |
