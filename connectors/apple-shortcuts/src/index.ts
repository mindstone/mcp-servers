#!/usr/bin/env node
/**
 * MCP Server for Apple Shortcuts
 *
 * Provides tools to interact with macOS Shortcuts via the `shortcuts` CLI.
 * Supports listing available shortcuts, opening one in the Shortcuts editor,
 * and running them with optional input.
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

// =============================================================================
// CLI Invocation Helpers
// =============================================================================

export type ShortcutsRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the process was terminated for exceeding the timeout. */
  timedOut?: boolean;
  /**
   * True when the timeout fired but termination could not be confirmed:
   * signal delivery failed, or the process never emitted `close` after
   * SIGKILL. Callers must not claim the process is gone on this path.
   */
  terminationUnconfirmed?: boolean;
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
 * Upper bound for `setTimeout`: Node clamps delays above 2^31-1ms to 1ms,
 * which would turn a large configured timeout into an instant termination.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Per-stream capture bound; output beyond this is dropped (see runShortcuts). */
export const MAX_CAPTURED_OUTPUT_CHARS = 1_000_000;
const TRUNCATION_MARKER = "\n[output truncated: exceeded 1000000 character capture limit]";

/**
 * Resolve the `shortcuts` CLI timeout from `APPLE_SHORTCUTS_TIMEOUT_MS`.
 * Anything unset, non-numeric, <= 0, or below 1ms after flooring falls back
 * to the default — a shortcut must never be allowed to hang a tool call
 * forever, nor be terminated instantly by accident. Values above the Node
 * timer range are clamped to it.
 */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APPLE_SHORTCUTS_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Do not echo the raw value: a misconfigured environment can place
    // secret material here, and stderr logs must not capture it.
    logger.warn(
      `Invalid APPLE_SHORTCUTS_TIMEOUT_MS (expected a positive number of milliseconds); falling back to ${DEFAULT_TIMEOUT_MS}ms`
    );
    return DEFAULT_TIMEOUT_MS;
  }
  const floored = Math.floor(parsed);
  if (floored < 1) {
    logger.warn(
      `Invalid APPLE_SHORTCUTS_TIMEOUT_MS (below 1ms after rounding); falling back to ${DEFAULT_TIMEOUT_MS}ms`
    );
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(floored, MAX_TIMEOUT_MS);
}

/**
 * Spawn the `shortcuts` CLI with given argv, returning stdout on success.
 * Uses argv array — no shell interpolation.
 *
 * The process is terminated (SIGTERM, then SIGKILL after a grace period) when
 * it exceeds APPLE_SHORTCUTS_TIMEOUT_MS (default 120s): shortcuts that open
 * GUI dialogs otherwise block the tool call indefinitely. If signal delivery
 * fails or the process never emits `close` after SIGKILL, the call settles
 * anyway after a further grace period rather than hanging forever — with
 * `terminationUnconfirmed: true`, because the process may still be running.
 *
 * Captured stdout/stderr are bounded at MAX_CAPTURED_OUTPUT_CHARS per stream;
 * further output is dropped and a truncation marker appended, so a shortcut
 * emitting unbounded output cannot exhaust memory before the timeout fires.
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
    let settleTimer: NodeJS.Timeout | undefined;

    const finish = (result: ShortcutsRunResult) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve(result);
    };

    const tryKill = (signal: "SIGTERM" | "SIGKILL"): boolean => {
      try {
        return proc.kill(signal);
      } catch {
        return false;
      }
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      // Log only the connector-authored subcommand — the full argv contains
      // the user-authored shortcut name and any temporary input path, which
      // may carry private data and must not reach log files.
      logger.warn(
        `"shortcuts ${argv[0]}" exceeded the ${timeoutMs}ms timeout; terminating`
      );
      if (!tryKill("SIGTERM")) {
        logger.warn(`SIGTERM delivery failed for "shortcuts ${argv[0]}"; escalating`);
      }
      killTimer = setTimeout(() => {
        if (!tryKill("SIGKILL")) {
          logger.warn(`SIGKILL delivery failed for "shortcuts ${argv[0]}"`);
        }
        // Backstop: an unkillable (or already-reaped-without-close) process
        // must not leave the tool call pending forever.
        settleTimer = setTimeout(() => {
          logger.warn(
            `"shortcuts ${argv[0]}" did not exit after SIGKILL; releasing the tool call`
          );
          finish({
            stdout,
            stderr,
            exitCode: 1,
            timedOut: true,
            terminationUnconfirmed: true,
          });
        }, SIGKILL_GRACE_MS);
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      if (stdout.length >= MAX_CAPTURED_OUTPUT_CHARS) return;
      stdout += data.toString();
      if (stdout.length > MAX_CAPTURED_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_CAPTURED_OUTPUT_CHARS) + TRUNCATION_MARKER;
        logger.warn(`"shortcuts ${argv[0]}" stdout exceeded the capture limit; truncating`);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      if (stderr.length >= MAX_CAPTURED_OUTPUT_CHARS) return;
      stderr += data.toString();
      if (stderr.length > MAX_CAPTURED_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_CAPTURED_OUTPUT_CHARS) + TRUNCATION_MARKER;
        logger.warn(`"shortcuts ${argv[0]}" stderr exceeded the capture limit; truncating`);
      }
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

/**
 * `wrapUntrusted` narrowed to defined input; CLI output here is never undefined.
 * Fails closed: if the helper contract ever changes and returns undefined for
 * defined input, throw rather than fall back to returning raw untrusted text.
 */
function envelope(text: string, source: string): string {
  const wrapped = wrapUntrusted(text, source);
  if (wrapped === undefined) {
    throw new Error("untrusted-content envelope helper returned no result for defined input");
  }
  return wrapped;
}

function timedOutResult(what: string, terminationUnconfirmed = false) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text:
          terminationUnconfirmed
            ? `${what} did not finish within ${resolveTimeoutMs()}ms; termination was requested but could not be confirmed — the process may still be running. ` +
              `Set APPLE_SHORTCUTS_TIMEOUT_MS to allow longer runs.`
            : `${what} did not finish within ${resolveTimeoutMs()}ms and was terminated. ` +
              `Set APPLE_SHORTCUTS_TIMEOUT_MS to allow longer runs.`,
      },
    ],
  };
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

export function createListShortcutsHandler(runner: ShortcutsRunner = runShortcuts) {
  return async (params: ListShortcutsInput) => {
    // Parse at the boundary too: embedders calling this factory directly do
    // not get the MCP SDK's validation, and the handler must stay fail-closed.
    const parsed = ListShortcutsInputSchema.parse(params);
    const argv: string[] = ["list"];
    if (parsed.folder_name !== undefined) {
      argv.push("--folder-name", parsed.folder_name);
    }
    if (parsed.show_identifiers) {
      argv.push("--show-identifiers");
    }

    const result = await runner(argv);

    if (result.timedOut) {
      return timedOutResult("Listing shortcuts", result.terminationUnconfirmed);
    }

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list shortcuts (exit ${result.exitCode}): ${envelope(result.stderr || result.stdout, SOURCES.list)}`,
          },
        ],
      };
    }

    const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No shortcuts found." }],
      };
    }

    const formatted = lines.map((line) => `• ${line.trim()}`).join("\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Shortcuts (${lines.length}):\n${envelope(formatted, SOURCES.list)}`,
        },
      ],
    };
  };
}

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
 * failing CLI invocation does not leave the user's input on disk; a cleanup
 * failure is logged (it leaves user input at rest) rather than ignored.
 */
export function createRunShortcutHandler(runner: ShortcutsRunner = runShortcuts) {
  return async (params: RunShortcutInput) => {
    // Parse at the boundary too: embedders calling this factory directly do
    // not get the MCP SDK's validation, and the handler must stay fail-closed.
    const parsed = RunShortcutInputSchema.parse(params);
    const argv: string[] = ["run", parsed.name];

    let tempDir: string | undefined;
    let tempPath: string | undefined;

    try {
      if (parsed.input !== undefined) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-sc-"));
        tempPath = path.join(tempDir, "input.txt");
        // Create with mode 0o600 and re-chmod to defeat any umask interference.
        fs.writeFileSync(tempPath, parsed.input, { mode: 0o600 });
        fs.chmodSync(tempPath, 0o600);
        argv.push("--input-path", tempPath);
      }

      const result = await runner(argv);

      if (result.timedOut) {
        const partial = result.stdout.trim();
        const outcome = result.terminationUnconfirmed
          ? `did not finish within ${resolveTimeoutMs()}ms; termination was requested but could not be confirmed — the shortcut may still be running. `
          : `did not finish within ${resolveTimeoutMs()}ms and was terminated. `;
        return {
          isError: true as const,
          content: [
            {
              type: "text" as const,
              text:
                `Shortcut "${envelope(parsed.name, SOURCES.run)}" ${outcome}` +
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
              text: `Failed to run shortcut "${envelope(parsed.name, SOURCES.run)}" (exit ${result.exitCode}): ${envelope(result.stderr || result.stdout, SOURCES.run)}`,
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
              text: `Shortcut "${envelope(parsed.name, SOURCES.run)}" ran successfully with no output.`,
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
        } catch (err) {
          // Best-effort, but observable: a failure leaves user input at rest.
          logger.warn("Failed to remove temporary shortcut input file", err);
        }
      }
      if (tempDir !== undefined) {
        try {
          fs.rmdirSync(tempDir);
        } catch (err) {
          logger.warn("Failed to remove temporary shortcut input directory", err);
        }
      }
    }
  };
}

// =============================================================================
// Tool: apple_shortcuts_view
// =============================================================================

export const ViewShortcutInputSchema = z.object({
  name: z
    .string()
    .min(1, "Shortcut name is required")
    .describe("The name or identifier of the shortcut to open in the Shortcuts editor"),
}).strict();

export type ViewShortcutInput = z.infer<typeof ViewShortcutInputSchema>;

export function createViewShortcutHandler(runner: ShortcutsRunner = runShortcuts) {
  return async (params: ViewShortcutInput) => {
    // Parse at the boundary too: embedders calling this factory directly do
    // not get the MCP SDK's validation, and the handler must stay fail-closed.
    const parsed = ViewShortcutInputSchema.parse(params);
    const result = await runner(["view", parsed.name]);

    if (result.timedOut) {
      return timedOutResult(
        `Opening shortcut "${envelope(parsed.name, SOURCES.view)}"`,
        result.terminationUnconfirmed
      );
    }

    if (result.exitCode !== 0) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to open shortcut "${envelope(parsed.name, SOURCES.view)}" (exit ${result.exitCode}): ${envelope(result.stderr || result.stdout, SOURCES.view)}`,
          },
        ],
      };
    }

    const output = result.stdout.trim();
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Opened shortcut "${envelope(parsed.name, SOURCES.view)}" in the Shortcuts app editor.` +
            (output ? `\n${envelope(output, SOURCES.view)}` : ""),
        },
      ],
    };
  };
}

// =============================================================================
// Server factory
// =============================================================================

/**
 * Build the MCP server with all tools registered. Factored out so tests can
 * inject a fake `runner` (the `shortcuts` CLI only exists on macOS).
 */
export function createServer(runner: ShortcutsRunner = runShortcuts): McpServer {
  const server = new McpServer({
    name: "apple-shortcuts-mcp",
    version: pkg.version,
  });

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
    createListShortcutsHandler(runner)
  );

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
    A shortcut can send messages, delete files, make purchases, control devices, or call
    remote APIs, so this tool is annotated as potentially destructive; hosts should
    require explicit user approval before running one.

Example:
  - "Run my 'Morning Briefing' shortcut" -> { name: "Morning Briefing" }
  - "Send a message via my workflow shortcut" -> { name: "Send Message", input: "Hello world" }`,
      inputSchema: RunShortcutInputSchema,
      annotations: {
        readOnlyHint: false,
        // A shortcut runs with the logged-in user's permissions and can send
        // messages, delete files, make purchases, or call remote APIs —
        // arbitrary execution must be annotated destructive (invariant #7).
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    createRunShortcutHandler(runner)
  );

  server.registerTool(
    "apple_shortcuts_view",
    {
      title: "View Apple Shortcut",
      description: `Open a named Apple Shortcut in the Shortcuts app editor on this Mac.

Use this tool so the user can visually review what a shortcut does before
running it. The shortcut's definition opens in the Shortcuts GUI — this tool
does NOT return the definition as text.

Args:
  - name (string): The exact name or identifier of the shortcut to open.

Returns:
  A confirmation that the shortcut was opened in the editor.

Example:
  - "Show me what my 'Morning Briefing' shortcut does" -> { name: "Morning Briefing" }`,
      inputSchema: ViewShortcutInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    createViewShortcutHandler(runner)
  );

  return server;
}

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  logger.info("Apple Shortcuts MCP server starting");
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
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
