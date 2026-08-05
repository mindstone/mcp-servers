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
import { wrapUntrusted } from "./untrusted-content.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const server = new McpServer({
  name: "apple-shortcuts-mcp",
  version: pkg.version,
});

// =============================================================================
// CLI Invocation Helpers
// =============================================================================

export type ShortcutsRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was terminated for exceeding the timeout. */
  timedOut?: boolean;
};

/**
 * Function shape used to invoke the `shortcuts` CLI. Exposed so tests can
 * inject a fake runner that records argv and inspects the temporary input
 * file before resolving.
 */
export type ShortcutsRunner = (argv: string[]) => Promise<ShortcutsRunResult>;

export const DEFAULT_TIMEOUT_MS = 120_000;
const SIGKILL_GRACE_MS = 5_000;

/**
 * Resolve the `shortcuts` CLI timeout from `APPLE_SHORTCUTS_TIMEOUT_MS`.
 * Anything unset, non-numeric, or <= 0 falls back to the default — a shortcut
 * must never be allowed to hang a tool call forever.
 */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_SHORTCUTS_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `Invalid APPLE_SHORTCUTS_TIMEOUT_MS "${raw}"; falling back to ${DEFAULT_TIMEOUT_MS}ms`
    );
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/**
 * Spawn the `shortcuts` CLI with given argv, returning stdout on success.
 * Uses argv array — no shell interpolation.
 *
 * The process is terminated (SIGTERM, then SIGKILL after a grace period) when
 * it exceeds APPLE_SHORTCUTS_TIMEOUT_MS (default 120s): shortcuts that open
 * GUI dialogs otherwise block the tool call indefinitely.
 */
export const runShortcuts: ShortcutsRunner = (argv) => {
  return new Promise((resolve) => {
    const timeoutMs = resolveTimeoutMs();
    const proc = spawn("shortcuts", argv, { shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (result: ShortcutsRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.warn(
        `"shortcuts ${argv.join(" ")}" exceeded the ${timeoutMs}ms timeout; terminating`
      );
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // process already exited
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      finish({ stdout: "", stderr: err.message, exitCode: 1 });
    });

    proc.on("close", (code) => {
      finish({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 1 : 0),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
};

// =============================================================================
// Shared result helpers
// =============================================================================

/** Envelope sources: everything the `shortcuts` CLI prints is user-authored. */
const SOURCES = {
  list: "apple-shortcuts:list",
  run: "apple-shortcuts:run",
  view: "apple-shortcuts:view",
} as const;

/** `wrapUntrusted` narrowed to defined input; CLI output here is never undefined. */
function envelope(text: string, source: string): string {
  return wrapUntrusted(text, source) ?? text;
}

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
  A formatted list of shortcut names (and optionally identifiers). Shortcut names
  are user-authored text and are returned inside an untrusted-content envelope.

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
            text: `Failed to list shortcuts (exit ${result.exitCode}): ${envelope(result.stderr || result.stdout, SOURCES.list)}`,
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
          text: `Shortcuts (${lines.length}):\n${envelope(formatted, SOURCES.list)}`,
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

      if (result.timedOut) {
        const partial = result.stdout.trim();
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text:
                `Shortcut "${params.name}" did not finish within ${resolveTimeoutMs()}ms and was terminated. ` +
                `Set APPLE_SHORTCUTS_TIMEOUT_MS to allow longer runs.` +
                (partial
                  ? `\nPartial output before termination:\n${envelope(partial, SOURCES.run)}`
                  : ""),
            },
          ],
        };
      }

      if (result.exitCode !== 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to run shortcut "${params.name}" (exit ${result.exitCode}): ${envelope(result.stderr || result.stdout, SOURCES.run)}`,
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
        content: [{ type: "text" as const, text: envelope(output, SOURCES.run) }],
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
  The stdout output from the shortcut, if any, inside an untrusted-content
  envelope (shortcut output is user-authored text).

Caveats:
  - Runs are terminated after APPLE_SHORTCUTS_TIMEOUT_MS milliseconds (default 120000);
    raise it for shortcuts that legitimately take longer.
  - Shortcuts that open GUI dialogs or request user confirmation will hit that timeout.
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
