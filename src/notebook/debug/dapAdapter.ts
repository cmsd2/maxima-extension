/**
 * Custom DebugAdapter that spawns maxima-dap as a child process,
 * relays DAP messages via stdin/stdout, and captures stderr to
 * a VS Code output channel.
 */

import * as vscode from "vscode";
import { ChildProcess, spawn } from "child_process";

export class DapProcessAdapter implements vscode.DebugAdapter {
  private process: ChildProcess;
  private messageEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.messageEmitter.event;
  private rawData = Buffer.alloc(0);

  constructor(
    command: string,
    outputChannel: vscode.OutputChannel,
    env: Record<string, string | undefined>,
  ) {
    this.process = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
    });

    // Capture stderr → output channel
    this.process.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) {
          outputChannel.appendLine(line);
        }
      }
    });

    // Parse DAP messages from stdout (Content-Length header framing)
    this.process.stdout?.on("data", (data: Buffer) => {
      this.handleData(data);
    });

    this.process.on("error", (err) => {
      outputChannel.appendLine(`maxima-dap spawn error: ${err.message}`);
    });

    this.process.on("exit", (code) => {
      outputChannel.appendLine(`maxima-dap exited (code ${code})`);
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    // VS Code → adapter: serialize as DAP wire format to stdin
    const json = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    this.process.stdin?.write(header + json);
  }

  private handleData(data: Buffer): void {
    // Standard DAP Content-Length framing parser
    this.rawData = Buffer.concat([this.rawData, data]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerEnd = this.rawData.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        break;
      }
      const header = this.rawData.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        break;
      }
      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.rawData.length < bodyStart + contentLength) {
        break;
      }
      const body = this.rawData
        .subarray(bodyStart, bodyStart + contentLength)
        .toString();
      this.rawData = this.rawData.subarray(bodyStart + contentLength);
      try {
        this.messageEmitter.fire(JSON.parse(body));
      } catch {
        /* skip malformed messages */
      }
    }
  }

  dispose(): void {
    this.process.kill();
    this.messageEmitter.dispose();
  }
}
