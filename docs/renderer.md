# Custom Notebook Renderers

Rich output rendering for Maxima notebook cells: LaTeX math, interactive
plots, and static graphics.

## Overview

VS Code notebook renderers run in a shared webview iframe, separate from
the extension host. They have full DOM and JavaScript access within their
output element but cannot access VS Code APIs directly.

The Maxima extension registers a single renderer that handles multiple
MIME types:

| MIME Type | Content | Rendering |
|-----------|---------|-----------|
| `application/x-maxima-latex` | TeX math string | KaTeX |
| `application/x-maxima-plotly` | Plotly JSON spec | Plotly.js |
| `application/x-maxima-output` | Structured text output | Custom HTML |

Additionally, these MIME types use VS Code's native renderers (no custom
code needed):

| MIME Type | Content | Renderer |
|-----------|---------|----------|
| `text/plain` | Plain text | Native |
| `image/svg+xml` | SVG markup | Native |
| error output | Error message | Native error banner |

## MIME Type Design

### Why Custom MIME Types?

VS Code does not natively render LaTeX or Plotly. Using standard MIME types
like `text/latex` would show raw TeX source. Custom MIME types ensure our
renderer handles these formats:

- `application/x-maxima-latex` → triggers our KaTeX renderer
- `application/x-maxima-plotly` → triggers our Plotly renderer

### ipynb MIME Mapping

When serializing to `.ipynb`, custom types are mapped to standard types for
compatibility:

| VS Code MIME | ipynb MIME | Direction |
|---|---|---|
| `application/x-maxima-latex` | `text/latex` | Serialize |
| `text/latex` | `application/x-maxima-latex` | Deserialize |
| `application/x-maxima-plotly` | `application/x-maxima-plotly` | Both |

This means `.ipynb` files saved by the extension can show LaTeX in Aximar
(which reads `text/latex`) and Plotly data in either tool.

## Renderer Registration

In `package.json`:

```json
{
  "contributes": {
    "notebookRenderer": [{
      "id": "maxima-notebook-renderer",
      "displayName": "Maxima Notebook Renderer",
      "entrypoint": "./out/renderers/maxima/index.js",
      "mimeTypes": [
        "application/x-maxima-latex",
        "application/x-maxima-plotly",
        "application/x-maxima-output"
      ],
      "requiresMessaging": "never"
    }]
  }
}
```

`requiresMessaging: "never"` means the renderer does not need to communicate
back to the extension host. All data needed for rendering is in the output
item's content.

## Renderer Entry Point

**File:** `src/renderers/maxima/index.ts`

```typescript
import type { ActivationFunction, OutputItem } from "vscode-notebook-renderer";

export const activate: ActivationFunction = (_context) => ({
  renderOutputItem(data: OutputItem, element: HTMLElement): void {
    switch (data.mime) {
      case "application/x-maxima-latex":
        renderLatex(data.text(), element);
        break;
      case "application/x-maxima-plotly":
        renderPlotly(data.text(), element);
        break;
      case "application/x-maxima-output":
        renderTextOutput(data.text(), element);
        break;
    }
  },
  disposeOutputItem(id?: string): void {
    // Cleanup: Plotly.purge() if needed
  },
});
```

## KaTeX Rendering

### Library

[KaTeX](https://katex.org/) is used for LaTeX math rendering. It's fast,
produces high-quality output, and works well in webview environments.

### Preprocessing

Maxima's `tex()` output may include constructs that KaTeX needs adjusted:

- Strip `$$...$$` delimiters (Aximar wraps TeX in display math markers)
- Handle Maxima-specific TeX macros
- The Aximar frontend has a `preprocessLatex()` function in
  `src/lib/katex-helpers.ts` that handles these transformations — we port
  the relevant logic

### Rendering

```typescript
import katex from "katex";
import "katex/dist/katex.min.css";

function renderLatex(latex: string, element: HTMLElement): void {
  element.classList.add("maxima-latex-output");
  try {
    katex.render(preprocessLatex(latex), element, {
      displayMode: true,
      throwOnError: false,
      trust: true,
      output: "htmlAndMathml",
    });
  } catch {
    // Fallback: show raw TeX
    element.textContent = latex;
  }
}
```

### Font Bundling

KaTeX requires web fonts (woff2/woff/ttf) for math symbols. These are
bundled via esbuild's file loader — they're emitted alongside the renderer
JS file and referenced by the bundled CSS.

## Plotly Rendering

### Library

[Plotly.js](https://plotly.com/javascript/) renders interactive charts.
We use `plotly.js-dist-min` (~1MB minified) for a smaller bundle.

### Lazy Loading

Plotly is loaded on first use to avoid loading ~1MB when only KaTeX is
needed:

```typescript
let Plotly: typeof import("plotly.js-dist-min") | undefined;

async function renderPlotly(jsonStr: string, element: HTMLElement): Promise<void> {
  if (!Plotly) {
    Plotly = await import("plotly.js-dist-min");
  }
  // ...render
}
```

### Input Format

aximar-mcp returns `plot_data` as a JSON string with the Plotly spec:

```json
{
  "data": [
    {
      "x": [1, 2, 3, 4, 5],
      "y": [1, 4, 9, 16, 25],
      "type": "scatter",
      "mode": "lines"
    }
  ],
  "layout": {
    "title": "x^2"
  }
}
```

This is produced by Maxima's `ax_draw2d()` / `ax_draw3d()` functions
(from aximar-core's plotting module).

### Theme Integration

Plotly charts adapt to VS Code's color theme:

```typescript
const layout = {
  ...spec.layout,
  paper_bgcolor: "transparent",
  plot_bgcolor: "transparent",
  font: {
    color: "var(--vscode-editor-foreground)",
    family: "var(--vscode-font-family)",
  },
  xaxis: {
    ...spec.layout?.xaxis,
    gridcolor: "var(--vscode-editorWidget-border)",
    zerolinecolor: "var(--vscode-editorWidget-border)",
  },
  yaxis: {
    ...spec.layout?.yaxis,
    gridcolor: "var(--vscode-editorWidget-border)",
    zerolinecolor: "var(--vscode-editorWidget-border)",
  },
};
```

### Responsive Layout

```typescript
const config = {
  responsive: true,
  displayModeBar: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["sendDataToCloud"],
};

const plotDiv = document.createElement("div");
plotDiv.style.width = "100%";
plotDiv.style.minHeight = "400px";
element.appendChild(plotDiv);

await Plotly.newPlot(plotDiv, spec.data, layout, config);
```

## SVG Rendering

SVG plots from `plot2d()` / `plot3d()` use Maxima's gnuplot backend. The
SVG XML is returned as `plot_svg` in the evaluation result.

These render via VS Code's **native** `image/svg+xml` renderer — no custom
code needed. The controller outputs the SVG as:

```typescript
vscode.NotebookCellOutputItem.text(plotSvg, "image/svg+xml")
```

## CSS Styling

**File:** `src/renderers/maxima/style.css`

All styles use VS Code CSS variables for theme compatibility:

```css
/* LaTeX output */
.maxima-latex-output {
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 1.15em;
  line-height: 1.6;
}

.maxima-latex-output .katex-display {
  margin: 0;
  text-align: left;
}

/* Plotly output */
.maxima-plotly-output {
  padding: 8px;
  border-radius: 4px;
}

/* Text output */
.maxima-text-output pre {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  line-height: var(--vscode-editor-line-height);
  color: var(--vscode-editor-foreground);
  background: transparent;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
  padding: 8px 12px;
}
```

### Theme Variables Used

| Variable | Purpose |
|----------|---------|
| `--vscode-editor-foreground` | Text color |
| `--vscode-editor-background` | Background (usually transparent) |
| `--vscode-editor-font-family` | Monospace font |
| `--vscode-editor-font-size` | Font size |
| `--vscode-editor-line-height` | Line height |
| `--vscode-editorWidget-border` | Chart grid lines |
| `--vscode-font-family` | UI font (for chart labels) |

## Build Configuration

The renderer is built as a separate bundle from the extension host.

**File:** `esbuild.mjs`

```javascript
const rendererConfig = {
  entryPoints: ["src/renderers/maxima/index.ts"],
  bundle: true,
  format: "esm",          // Renderers use ES modules
  platform: "browser",     // Runs in webview, not Node.js
  outfile: "out/renderers/maxima/index.js",
  external: [],            // Bundle everything (no node_modules in webview)
  minify: production,
  sourcemap: !production,
  loader: {
    ".css": "css",         // Inline CSS (KaTeX styles)
    ".woff2": "file",      // KaTeX fonts → emitted as files
    ".woff": "file",
    ".ttf": "file",
  },
};
```

Key differences from the extension host bundle:

| Property | Extension Host | Renderer |
|----------|---------------|----------|
| `format` | `cjs` (CommonJS) | `esm` (ES Modules) |
| `platform` | `node` | `browser` |
| `external` | `["vscode"]` | `[]` (bundle everything) |
| `loader` | default | CSS + font file loaders |

Both targets build in parallel. In watch mode, both use `esbuild.context()`
for incremental rebuilds.

### tsconfig.json

The renderer code needs DOM types. Add `"DOM"` to the `lib` array:

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM"]
  }
}
```

This makes `document`, `HTMLElement`, etc. available for type-checking.

## Output Examples

### LaTeX Math

Input cell: `integrate(x^2, x);`

Output MIME data:
- `application/x-maxima-latex`: `{{x^3}\over{3}}`
- `text/plain`: `x^3/3` (fallback)

Rendered: A beautifully typeset fraction x^3/3 via KaTeX.

### Interactive Plot

Input cell: `ax_draw2d(explicit(sin(x), x, -%pi, %pi));`

Output MIME data:
- `application/x-maxima-plotly`: `{"data":[{"x":[...],"y":[...],"type":"scatter"}],"layout":{...}}`

Rendered: An interactive Plotly chart with hover tooltips, zoom, pan, and
export buttons.

### Static Plot

Input cell: `plot2d(sin(x), [x, -5, 5])$`

Output MIME data:
- `image/svg+xml`: `<svg xmlns="...">...</svg>`

Rendered: A static SVG image via VS Code's native renderer.

### Error

Input cell: `1/0;`

Output: VS Code error banner with the error message from Maxima.

### Text + LaTeX Combined

Input cell:
```maxima
print("The result is:");
integrate(sin(x)^2, x);
```

Two output blocks:
1. `text/plain`: `"The result is:"`
2. `application/x-maxima-latex`: `{{x}\over{2}}-{{\sin\left(2\,x\right)}\over{4}}`
