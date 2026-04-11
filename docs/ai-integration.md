# AI Agent Integration

How AI agents (VS Code Copilot, Claude, etc.) interact with Maxima notebooks,
evaluation sessions, and debug sessions.

## Overview

AI agents access Maxima through two complementary tool sets:

1. **MCP tools** — aximar-mcp's 24 native tools, exposed via
   `registerMcpServerDefinitionProvider`. Direct access to evaluate code,
   search documentation, manage sessions. Results go to the AI (chat), not
   the notebook UI.

2. **LM tools** — Extension-side tools registered via
   `vscode.lm.registerTool()`. Bridge between AI and VS Code's notebook/debug
   APIs. Can read notebook state, trigger cell execution (with output
   appearing in the UI), and inspect debug sessions.

```
AI Agent
├── MCP tools (direct to aximar-mcp HTTP)
│   ├── evaluate_expression    → run code, get result in chat
│   ├── search_functions       → look up Maxima functions
│   ├── get_function_docs      → full documentation with examples
│   ├── list_variables         → inspect session variables
│   ├── restart_session        → restart Maxima
│   └── ... (24 tools total)
│
└── LM tools (via extension bridge)
    ├── maxima_notebook_get_cells  → see all cells + outputs
    ├── maxima_notebook_run_cell   → execute cell, output in UI
    ├── maxima_notebook_add_cell   → add cell to notebook
    ├── maxima_debug_variables     → inspect debug variables
    ├── maxima_debug_evaluate      → eval in debug context
    └── maxima_debug_callstack     → get call stack
```

## Shared Maxima Session

The notebook controller and AI agents share the same aximar-mcp process
(HTTP transport). When AI calls `evaluate_expression`, it runs in the same
Maxima session as the notebook — same variables, same state, same
definitions.

**How it works:**

1. Extension spawns `aximar-mcp --http --no-auth` (one process)
2. Notebook controller connects and creates `notebook_id: "nb-1"`
3. MCP provider returns `McpHttpServerDefinition` pointing to same URL
4. AI agent connects (via VS Code's built-in MCP client)
5. AI calls `evaluate_expression(expression, notebook_id: "nb-1")`
6. Evaluation runs in the same Maxima process as notebook cells

**Multi-notebook routing:** aximar-mcp's `NotebookRegistry` supports
multiple notebooks. AI can specify `notebook_id` to target a specific
notebook's session. Without `notebook_id`, requests go to the active
notebook.

## MCP Tools (Direct Access)

These are aximar-mcp's native tools, available to AI via the MCP server
definition provider. The AI talks directly to aximar-mcp over HTTP.

### Documentation & Catalog

| Tool | Parameters | Returns |
|------|-----------|---------|
| `search_functions` | `query: string` | Matching functions with signatures |
| `get_function_docs` | `name: string` | Full docs, examples, related functions |
| `complete_function` | `prefix: string` | Autocomplete suggestions |
| `search_packages` | `query: string` | Matching packages |
| `list_packages` | — | All available packages |
| `get_package` | `name: string` | Package functions and description |
| `list_deprecated` | — | Deprecated functions with replacements |

### Evaluation & Session

| Tool | Parameters | Returns |
|------|-----------|---------|
| `evaluate_expression` | `expression, notebook_id?` | `{ text_output, latex, plot_svg, plot_data, error, is_error, output_label }` |
| `get_session_status` | `notebook_id?` | `{ status: Starting\|Ready\|Busy\|Stopped\|Error }` |
| `restart_session` | `notebook_id?` | — |
| `list_variables` | `notebook_id?` | `{ variables: string[] }` |
| `kill_variable` | `name, notebook_id?` | — |

### Notebook Management

| Tool | Parameters | Returns |
|------|-----------|---------|
| `list_notebooks` | — | Open notebooks with IDs |
| `create_notebook` | — | `{ notebook_id }` |
| `close_notebook` | `notebook_id` | — |
| `list_cells` | `notebook_id?` | Cell summaries |
| `get_cell` | `cell_id, notebook_id?` | Full cell with output |
| `add_cell` | `cell_type?, input?, after_cell_id?, notebook_id?` | `{ cell_id }` |
| `run_cell` | `cell_id, notebook_id?` | Evaluation result |
| `run_all_cells` | `notebook_id?` | Results for each cell |

### File I/O

| Tool | Parameters | Returns |
|------|-----------|---------|
| `save_notebook` | `path, notebook_id?` | `{ saved, path }` |
| `open_notebook` | `path, notebook_id?` | `{ opened, path, cell_count }` |

**Note:** The notebook management and file I/O tools operate on aximar-mcp's
internal notebook state, which is separate from the VS Code notebook UI.
Changes made via these tools (e.g., `add_cell`) will NOT appear in the
VS Code editor. Use the LM tools below for UI-visible operations.

## LM Tools (Extension Bridge)

Registered via `vscode.lm.registerTool()` in `src/notebook/lmTools.ts`.
These tools have full access to VS Code APIs and bridge between the AI and
the notebook/debug UI.

### package.json Registration

Tools must be declared in `contributes.languageModelTools`:

```json
{
  "languageModelTools": [
    {
      "name": "maxima_notebook_get_cells",
      "displayName": "Get Maxima Notebook Cells",
      "modelDescription": "Get all cells from the active Maxima notebook with source code and execution outputs (text, LaTeX, plots, errors).",
      "inputSchema": {}
    }
  ]
}
```

### Notebook Tools

#### `maxima_notebook_get_cells`

Returns all cells from the active Maxima notebook with their source code and
outputs. AI sees what the user sees.

**Input:** `{}`

**Output:**
```json
{
  "cells": [
    {
      "index": 0,
      "kind": "code",
      "source": "integrate(x^2, x);",
      "executionCount": 1,
      "outputs": {
        "text": "",
        "latex": "{{x^3}\\over{3}}",
        "plotSvg": null,
        "plotData": null,
        "error": null,
        "isError": false
      }
    }
  ]
}
```

**Implementation:** Reads from `vscode.window.activeNotebookEditor.notebook`,
iterating cells and extracting output items by MIME type.

#### `maxima_notebook_run_cell`

Triggers execution of a specific cell. The output appears in the notebook UI
AND is returned to the AI.

**Input:** `{ cellIndex: number }`

**Output:** Same as `evaluate_expression` result.

**Implementation:** Calls the notebook controller's execute handler
programmatically, then reads the resulting output from the cell.

#### `maxima_notebook_add_cell`

Adds a new code cell to the notebook via `WorkspaceEdit` with
`NotebookEdit.insertCells()`.

**Input:** `{ source: string, afterIndex?: number }`

**Output:** `{ cellIndex: number }`

**Implementation:** Creates a `vscode.WorkspaceEdit`, adds a
`vscode.NotebookEdit.insertCells()` operation, applies it.

### Debug Tools

See [debugging.md](debugging.md) for full debug tool documentation.

#### `maxima_debug_variables`

Returns variables from the current stack frame in an active debug session.

**Implementation:** `activeDebugSession.customRequest("variables", { variablesReference })`

#### `maxima_debug_evaluate`

Evaluates an expression in the debug context (at the current breakpoint).

**Implementation:** `activeDebugSession.customRequest("evaluate", { expression, context: "repl" })`

#### `maxima_debug_callstack`

Returns the current call stack.

**Implementation:** `activeDebugSession.customRequest("stackTrace", { threadId: 1 })`

## MCP Server Provider

**File:** `src/extension.ts`

The MCP provider is reworked to auto-detect the extension-managed aximar-mcp:

```typescript
vscode.lm.registerMcpServerDefinitionProvider("maxima.mcpServer", {
  onDidChangeMcpServerDefinitions: mcpChanged.event,
  provideMcpServerDefinitions() {
    // If notebook's aximar-mcp is running, point to it
    if (managedMcpUrl) {
      return [new vscode.McpHttpServerDefinition("Maxima Notebook", managedMcpUrl)];
    }
    // Otherwise fall back to user-configured settings
    // (existing behavior: maxima.mcp.transport, maxima.mcp.url, etc.)
    return getUserConfiguredMcpServer();
  }
});
```

When the extension-managed aximar-mcp starts or stops, `mcpChanged.fire()`
notifies VS Code, and AI agents reconnect.

## What AI Can Do: Summary

| Action | Tool Set | UI Effect |
|--------|----------|-----------|
| Evaluate code | MCP: `evaluate_expression` | None (result in chat) |
| Look up documentation | MCP: `search_functions`, `get_function_docs` | None |
| List session variables | MCP: `list_variables` | None |
| See notebook cells | LM: `maxima_notebook_get_cells` | None (read-only) |
| Run a notebook cell | LM: `maxima_notebook_run_cell` | Output appears in notebook |
| Add a notebook cell | LM: `maxima_notebook_add_cell` | Cell appears in notebook |
| Inspect debug vars | LM: `maxima_debug_variables` | None (read-only) |
| Evaluate at breakpoint | LM: `maxima_debug_evaluate` | None (result in chat) |
| See call stack | LM: `maxima_debug_callstack` | None (read-only) |
| Restart session | MCP: `restart_session` | Notebook session resets |

## Example AI Workflows

### "Help me simplify this integral"

1. AI reads notebook with `maxima_notebook_get_cells`
2. Sees the integral and its output
3. Uses `evaluate_expression` to try alternative approaches
4. Suggests a simplified form and adds a cell with `maxima_notebook_add_cell`

### "Why is my function returning the wrong result?"

1. AI reads notebook cells to understand the function definition
2. Uses `evaluate_expression` to test edge cases
3. Looks up function docs with `get_function_docs`
4. Suggests a fix and runs it with `maxima_notebook_run_cell`

### "Help me debug this function"

1. User sets a breakpoint and runs "Debug Notebook"
2. Execution stops at the breakpoint
3. AI uses `maxima_debug_variables` to see local variable values
4. AI uses `maxima_debug_evaluate` to test expressions
5. AI uses `maxima_debug_callstack` to understand the call chain
6. AI explains the bug and suggests a fix
