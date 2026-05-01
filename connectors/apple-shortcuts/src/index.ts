#!/usr/bin/env node
/**
 * MCP Server for Apple Shortcuts
 *
 * Provides tools to interact with macOS Shortcuts via the `shortcuts` CLI.
 * Supports listing available shortcuts and running them with optional input.
 */

import { spawn } from "child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const server = new McpServer({
  name: "apple-shortcuts-mcp",
  version: pkg.version,
});

// =============================================================================
// CLI Invocation Helpers
// =============================================================================

export type ShortcutsRunResult = { stdout: string; stderr: string; exitCode: number };

/**
 * Function shape used to invoke the `shortcuts` CLI. Exposed so tests can
 * inject a fake runner that records argv and inspects the temporary input
 * file before resolving.
 */
export type ShortcutsRunner = (argv: string[]) => Promise<ShortcutsRunResult>;

/**
 * Spawn the `shortcuts` CLI with given argv, returning stdout on success.
 * Uses argv array — no shell interpolation.
 */
export const runShortcuts: ShortcutsRunner = (argv) => {
  return new Promise((resolve) => {
    const proc = spawn("shortcuts", argv, { shell: false });
    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
};

// =============================================================================
// Tool: apple_shortcuts_list
// =============================================================================

export const ListShortcutsInputSchema = z.object({
  folder_name: z
    .string()
    .optional()
    .describe("Optional folder name to list shortcuts from. Omit to list all shortcuts."),
  show_identifiers: z
    .boolean()
    .default(false)
    .describe("Whether to show internal identifiers alongside shortcut names."),
}).strict();

export type ListShortcutsInput = z.infer<typeof ListShortcutsInputSchema>;

server.registerTool(
  "apple_shortcuts_list",
  {
    title: "List Apple Shortcuts",
    description: `List all available Apple Shortcuts, optionally filtered by folder.

Use this tool to discover what shortcuts are available on this Mac before running one.

Args:
  - folder_name (string, optional): Filter to a specific folder. Use "none" to list shortcuts not in any folder.
  - show_identifiers (boolean, default: false): Include internal identifiers in the output.

Returns:
  A formatted list of shortcut names (and optionally identifiers).

Example:
  - "List all my shortcuts" -> {}
  - "What shortcuts are in the Work folder?" -> { folder_name: "Work" }
  - "Show shortcuts with their IDs" -> { show_identifiers: true }`,
    inputSchema: ListShortcutsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: ListShortcutsInput) => {
    const argv: string[] = ["list"];
    if (params.folder_name !== undefined) {
      argv.push("--folder-name", params.folder_name);
    }
    if (params.show_identifiers) {
      argv.push("--show-identifiers");
    }

    const result = await runShortcuts(argv);

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to list shortcuts (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
          },
        ],
      };
    }

    const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) {
      return {
        content: [{ type: "text", text: "No shortcuts found." }],
      };
    }

    const formatted = lines.map((line) => `• ${line.trim()}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Shortcuts (${lines.length}):\n${formatted}`,
        },
      ],
    };
  }
);

// =============================================================================
// Tool: apple_shortcuts_run
// =============================================================================

export const RunShortcutInputSchema = z.object({
  name: z
    .string()
    .min(1, "Shortcut name is required")
    .describe("The name or identifier of the shortcut to run"),
  input: z
    .string()
    .optional()
    .describe(
      "Optional text content to pass to the shortcut as its Magic Variable input. " +
        "Provide the literal text — the connector writes it to a private temporary " +
        "file and hands the resulting path to the `shortcuts` CLI."
    ),
}).strict();

export type RunShortcutInput = z.infer<typeof RunShortcutInputSchema>;

/**
 * Build the handler for `apple_shortcuts_run`. Factored as a factory so tests
 * can inject a fake `runner` that records argv and reads the temporary input
 * file before resolving.
 *
 * Security: when `input` is supplied, the text is written to a freshly-created
 * directory under `os.tmpdir()` (via `fs.mkdtempSync`) with mode `0o600`, and
 * that path is passed to `shortcuts run --input-path`. The temp file (and its
 * containing directory) are unlinked in a `finally` block so a crashed or
 * failing CLI invocation does not leave the user's input on disk.
 */
export function createRunShortcutHandler(runner: ShortcutsRunner = runShortcuts) {
  return async (params: RunShortcutInput) => {
    const argv: string[] = ["run", params.name];

    let tempDir: string | undefined;
    let tempPath: string | undefined;

    if (params.input !== undefined) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-sc-"));
      tempPath = path.join(tempDir, "input.txt");
      // Create with mode 0o600 and re-chmod to defeat any umask interference.
      fs.writeFileSync(tempPath, params.input, { mode: 0o600 });
      fs.chmodSync(tempPath, 0o600);
      argv.push("--input-path", tempPath);
    }

    try {
      const result = await runner(argv);

      if (result.exitCode !== 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to run shortcut "${params.name}" (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
            },
          ],
        };
      }

      const output = result.stdout.trim();
      if (!output) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Shortcut "${params.name}" ran successfully with no output.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: output }],
      };
    } finally {
      if (tempPath !== undefined) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // best-effort cleanup; ignore ENOENT etc.
        }
      }
      if (tempDir !== undefined) {
        try {
          fs.rmdirSync(tempDir);
        } catch {
          // best-effort cleanup
        }
      }
    }
  };
}

server.registerTool(
  "apple_shortcuts_run",
  {
    title: "Run Apple Shortcut",
    description: `Run a named Apple Shortcut, optionally with text input.

Use this tool to execute any shortcut the user has in their Shortcuts library.

Args:
  - name (string): The exact name or identifier of the shortcut to run.
  - input (string, optional): Text content to pass to the shortcut. Pass the
    literal text — the connector writes it to a private temporary file and
    hands that path to the macOS \`shortcuts\` CLI via --input-path. Do NOT
    pass a filesystem path here; doing so would only cause the shortcut to
    receive the path as text after the temp-file step.

Returns:
  The stdout output from the shortcut, if any.

Caveats:
  - Shortcuts that open GUI dialogs or request user confirmation may block indefinitely.
  - Shortcuts that take too long to run may cause the MCP request to time out.
  - Running shortcuts is not sandboxed — a shortcut has the same permissions as the logged-in user.

Example:
  - "Run my 'Morning Briefing' shortcut" -> { name: "Morning Briefing" }
  - "Send a message via my workflow shortcut" -> { name: "Send Message", input: "Hello world" }`,
    inputSchema: RunShortcutInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  createRunShortcutHandler()
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  logger.info("Apple Shortcuts MCP server starting");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Apple Shortcuts MCP server connected via stdio");
}

// Only auto-start the server when this module is the entrypoint — importing
// from tests must not connect a stdio transport.
const isEntrypoint = (() => {
  try {
    return process.argv[1] !== undefined &&
      fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  main().catch((err) => {
    logger.error("Server error", err);
    process.exit(1);
  });
}
