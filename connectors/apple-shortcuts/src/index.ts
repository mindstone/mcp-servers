#!/usr/bin/env node
/**
 * MCP Server for Apple Shortcuts
 *
 * Provides tools to interact with macOS Shortcuts via the `shortcuts` CLI.
 * Supports listing available shortcuts and running them with optional input.
 */

import { spawn } from "child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

const server = new McpServer({
  name: "apple-shortcuts-mcp",
  version: "1.0.0",
});

// =============================================================================
// CLI Invocation Helpers
// =============================================================================

/**
 * Spawn the `shortcuts` CLI with given argv, returning stdout on success.
 * Uses argv array — no shell interpolation.
 */
function runShortcuts(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
}

// =============================================================================
// Tool: apple_shortcuts_list
// =============================================================================

const ListShortcutsInputSchema = z.object({
  folder_name: z
    .string()
    .optional()
    .describe("Optional folder name to list shortcuts from. Omit to list all shortcuts."),
  show_identifiers: z
    .boolean()
    .default(false)
    .describe("Whether to show internal identifiers alongside shortcut names."),
}).strict();

type ListShortcutsInput = z.infer<typeof ListShortcutsInputSchema>;

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

const RunShortcutInputSchema = z.object({
  name: z
    .string()
    .min(1, "Shortcut name is required")
    .describe("The name or identifier of the shortcut to run"),
  input: z
    .string()
    .optional()
    .describe(
      "Optional text input to pass to the shortcut as --input-path. " +
        "The shortcut receives this as its Magic Variable input."
    ),
}).strict();

type RunShortcutInput = z.infer<typeof RunShortcutInputSchema>;

server.registerTool(
  "apple_shortcuts_run",
  {
    title: "Run Apple Shortcut",
    description: `Run a named Apple Shortcut, optionally with text input.

Use this tool to execute any shortcut the user has in their Shortcuts library.

Args:
  - name (string): The exact name or identifier of the shortcut to run.
  - input (string, optional): Text to pass as input to the shortcut.

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
  async (params: RunShortcutInput) => {
    const argv: string[] = ["run", params.name];
    if (params.input !== undefined) {
      argv.push("--input-path", params.input);
    }

    const result = await runShortcuts(argv);

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to run shortcut "${params.name}" (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
          },
        ],
      };
    }

    const output = result.stdout.trim();
    if (!output) {
      return {
        content: [{ type: "text", text: `Shortcut "${params.name}" ran successfully with no output.` }],
      };
    }

    return {
      content: [{ type: "text", text: output }],
    };
  }
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

main().catch((err) => {
  logger.error("Server error", err);
  process.exit(1);
});
