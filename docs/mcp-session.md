# MCP Session Management

How the extension manages the aximar-mcp process, shares sessions between
the notebook and AI agents, and tracks labels for correct `%` behavior.

## aximar-mcp Lifecycle

The extension manages a single `aximar-mcp` process with HTTP transport.
This process is shared between the notebook controller and AI agents.

### Startup

aximar-mcp is spawned **lazily** — on first need (notebook open, AI tool
call, or explicit session request):

```
aximar-mcp --http --port 19542 --no-auth --allow-dangerous
```

| Flag | Purpose |
|------|---------|
| `--http` | Enable HTTP transport (required for multi-client) |
| `--port 19542` | Listen port (configurable via settings) |
| `--no-auth` | Disable bearer token auth (localhost only) |
| `--allow-dangerous` | Skip dangerous-function approval gate |

The `--allow-dangerous` flag is appropriate because the notebook is the
user's own editor — they control what code they run. Without this flag,
functions like `system()` would block waiting for approval that only the
Tauri GUI can provide.

### Process Management

**File:** `src/notebook/mcpClient.ts`

```typescript
class McpProcessManager {
  private process: ChildProcess | undefined;
  private port: number;
  private client: Client | undefined;

  async ensureRunning(): Promise<void> {
    if (this.process && !this.process.killed) return;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const config = vscode.workspace.getConfiguration("maxima");
    const mcpPath = config.get<string>("notebook.mcpPath", "").trim() || "aximar-mcp";
    this.port = config.get<number>("notebook.mcpPort", 19542);

    this.process = spawn(mcpPath, [
      "--http",
      "--port", String(this.port),
      "--no-auth",
      "--allow-dangerous",
    ]);

    // Wait for HTTP server to be ready
    await this.waitForReady();

    // Connect MCP client
    this.client = new Client({ name: "maxima-notebook", version: "0.1.0" }, {});
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${this.port}/mcp`)
    );
    await this.client.connect(transport);
  }

  async dispose(): Promise<void> {
    await this.client?.close();
    this.process?.kill();
  }
}
```

### Shutdown

The process is killed when the extension deactivates. If the process
crashes, the manager detects this on the next operation and respawns.

### Crash Recovery

If aximar-mcp dies unexpectedly:
1. The next `evaluateExpression` call detects the closed transport
2. Manager disposes the dead client
3. Manager spawns a new aximar-mcp process
4. New MCP notebooks are created for each open VS Code notebook
5. Session state (variables, definitions) is lost — the user sees an
   info message suggesting they re-run cells

## MCP Server Provider

The existing MCP server provider (`registerMcpServerDefinitionProvider`) is
reworked to auto-detect the extension-managed process.

### Behavior

1. **Notebook process running:** Provider returns `McpHttpServerDefinition`
   pointing to `http://localhost:<port>/mcp`. AI agents connect to the
   notebook's session.
2. **No notebook process:** Falls back to user-configured settings
   (`maxima.mcp.transport`, `maxima.mcp.url`, `maxima.mcp.path`). This
   preserves the existing behavior for users who run aximar-mcp externally.

### Implementation

```typescript
vscode.lm.registerMcpServerDefinitionProvider("maxima.mcpServer", {
  onDidChangeMcpServerDefinitions: mcpChanged.event,

  provideMcpServerDefinitions() {
    // Prefer the managed process
    if (mcpManager.isRunning()) {
      return [
        new vscode.McpHttpServerDefinition(
          "Maxima Notebook",
          vscode.Uri.parse(`http://localhost:${mcpManager.port}/mcp`)
        ),
      ];
    }

    // Fall back to user settings
    const cfg = vscode.workspace.getConfiguration("maxima");
    if (!cfg.get<boolean>("mcp.enabled", false)) return [];

    const transport = cfg.get<string>("mcp.transport", "http");
    if (transport === "http") {
      const url = cfg.get<string>("mcp.url", "").trim();
      return url ? [new vscode.McpHttpServerDefinition("Maxima MCP", vscode.Uri.parse(url))] : [];
    } else {
      const path = cfg.get<string>("mcp.path", "").trim();
      const args = cfg.get<string[]>("mcp.args", []);
      return path ? [new vscode.McpStdioServerDefinition("Maxima MCP", path, args)] : [];
    }
  },

  async resolveMcpServerDefinition(server) {
    // Inject auth token for user-configured HTTP servers
    if (server instanceof vscode.McpHttpServerDefinition && !mcpManager.isRunning()) {
      const token = await context.secrets.get("maxima.mcp.token");
      if (token) {
        server.headers = { ...server.headers, Authorization: `Bearer ${token}` };
      }
    }
    return server;
  },
});
```

The provider fires `mcpChanged` when:
- The managed aximar-mcp process starts or stops
- User changes MCP configuration settings
- Token is set or cleared

## Multi-Notebook Support

aximar-mcp's `NotebookRegistry` supports multiple notebooks in a single
process. Each notebook has its own:
- Maxima child process (session isolation)
- Cell list and outputs
- Session state machine (Starting → Ready → Busy → Stopped/Error)
- Output capture sink

### Notebook Routing

The notebook controller creates one aximar-mcp notebook per VS Code
notebook document:

```typescript
// On notebook open
const result = await mcpClient.callTool("create_notebook", {});
const notebookId = JSON.parse(result).notebook_id; // "nb-1"

// Store mapping
notebookMap.set(vsCodeNotebook.uri.toString(), notebookId);

// On cell execution
await mcpClient.callTool("evaluate_expression", {
  expression: rewrittenCode,
  notebook_id: notebookId,
});

// On notebook close
await mcpClient.callTool("close_notebook", { notebook_id: notebookId });
```

### AI Notebook Access

AI agents can specify `notebook_id` in MCP tool calls to target a specific
notebook. Without `notebook_id`, requests go to the active notebook (the
most recently used one).

The LM tools (`maxima_notebook_get_cells`, `maxima_notebook_run_cell`)
always operate on the VS Code active notebook editor, so there's no
ambiguity.

## Label Tracking

### Why Labels Matter

Maxima uses output labels (`%o1`, `%o2`, ...) internally, but the actual
label numbers don't match the display execution count in the notebook.
Example:

| Cell | Display Count | Maxima Label | Reason |
|------|---------------|--------------|--------|
| 1 | 1 | `%o3` | Maxima ran 2 init commands first |
| 2 | 2 | `%o7` | Cell 1 had internal sub-evaluations |
| 3 | 3 | `%o8` | Simple expression |

If cell 3 contains `%o1 + %o2`, the user means "output of cell 1 + output
of cell 2." But Maxima sees `%o1` as its own first output (an init
command), not cell 1's output. Label rewriting translates display labels
to real labels.

### LabelContext

```typescript
interface LabelContext {
  /** Maps display execution count → real Maxima label */
  labelMap: Map<number, string>;
  /** Real Maxima label of the cell above (for bare %) */
  previousOutputLabel: string | undefined;
}
```

### Building the Context

Before each cell execution:

```typescript
function buildLabelContext(
  notebook: vscode.NotebookDocument,
  cellIndex: number,
  labelMap: Map<number, string>,
): LabelContext {
  // Walk backwards from cellIndex - 1 to find previousOutputLabel
  let previousOutputLabel: string | undefined;
  for (let i = cellIndex - 1; i >= 0; i--) {
    const cell = notebook.cellAt(i);
    const meta = cell.metadata as MaximaCellMetadata | undefined;
    if (meta?.outputLabel) {
      previousOutputLabel = meta.outputLabel;
      break;
    }
  }

  return { labelMap, previousOutputLabel };
}
```

### Recording Labels

After each successful execution:

```typescript
// From evaluate_expression response
const outputLabel = result.output_label; // e.g. "%o6"

if (outputLabel) {
  // Record in cell metadata
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.updateCellMetadata(cellIndex, {
      ...cell.metadata,
      outputLabel,
      executionCount,
    }),
  ]);
  await vscode.workspace.applyEdit(edit);

  // Record in label map
  labelMap.set(executionCount, outputLabel);
}
```

### State Reset

When the kernel is restarted:
- Clear `labelMap`
- Reset execution counter to 0
- Cell metadata (`outputLabel`) remains but is stale — it refers to the
  previous session's labels. This is harmless because the label map is
  empty, so display label references fall through unchanged.

On re-execution, new labels are recorded and the map rebuilds.

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxima.notebook.mcpPath` | string | `""` | Path to aximar-mcp. Searches PATH if empty. |
| `maxima.notebook.evalTimeout` | number | `60` | Cell evaluation timeout in seconds. |
| `maxima.mcp.enabled` | boolean | `false` | Enable user-configured MCP server (fallback). |
| `maxima.mcp.transport` | string | `"http"` | Fallback transport: `"http"` or `"stdio"`. |
| `maxima.mcp.url` | string | `""` | Fallback HTTP URL. |
| `maxima.mcp.path` | string | `""` | Fallback stdio binary path. |

## Sequence Diagram: Full Cell Execution

```
User clicks Run Cell
        │
        ▼
NotebookController
  │ cell = notebook.cellAt(index)
  │ source = cell.document.getText()
  │ ctx = buildLabelContext(notebook, index, labelMap)
  │ rewritten = rewriteLabels(source, ctx)
  │
  ├──► McpProcessManager.ensureRunning()
  │    (spawns aximar-mcp if needed)
  │
  ├──► McpClient.callTool("evaluate_expression", {
  │      expression: rewritten,
  │      notebook_id: notebookId
  │    })
  │
  │    aximar-mcp receives request
  │    │ unicode_to_maxima(expression)
  │    │ protocol::evaluate_with_packages(process, ...)
  │    │ parser::parse_output() → EvalResult
  │    │ Returns JSON response
  │
  │◄── { text_output, latex, plot_svg, plot_data,
  │      error, is_error, duration_ms, output_label }
  │
  │ Record output_label in cell metadata + labelMap
  │ Map fields to MIME types
  │ execution.replaceOutput(outputs)
  │ execution.end(success, timestamp)
  │
  ▼
VS Code renders cell output
```
