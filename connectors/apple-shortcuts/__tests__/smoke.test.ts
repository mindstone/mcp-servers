/**
 * Smoke tests for the apple-shortcuts MCP server, driven through the shared
 * test harness (InMemoryTransport + real MCP protocol) with an injected fake
 * `shortcuts` CLI runner — the real CLI only exists on macOS.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createInMemoryTestClient, type McpTestClient } from "@mindstone/mcp-test-harness";

import {
  createServer,
  type ShortcutsRunner,
  type ShortcutsRunResult,
} from "../dist/index.js";

const ENVELOPE_OPEN = '<untrusted-content source="apple-shortcuts:';
const ENVELOPE_CLOSE = "</untrusted-content>";

function routingRunner(routes: {
  list?: ShortcutsRunResult;
  run?: ShortcutsRunResult;
  view?: ShortcutsRunResult;
}): { runner: ShortcutsRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ShortcutsRunner = async (argv) => {
    calls.push([...argv]);
    const route = routes[argv[0] as keyof typeof routes];
    return route ?? { stdout: "", stderr: `unexpected subcommand: ${argv[0]}`, exitCode: 1 };
  };
  return { runner, calls };
}

describe("apple-shortcuts smoke", () => {
  let testClient: McpTestClient | undefined;

  afterEach(async () => {
    if (testClient) {
      await testClient.close();
      testClient = undefined;
    }
  });

  async function connect(routes: Parameters<typeof routingRunner>[0]) {
    const { runner, calls } = routingRunner(routes);
    testClient = await createInMemoryTestClient({
      createServer: () => createServer(runner),
    });
    return { client: testClient, calls };
  }

  it("lists all three tools via the MCP protocol", async () => {
    const { client } = await connect({});
    const { tools } = await client.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "apple_shortcuts_list",
      "apple_shortcuts_run",
      "apple_shortcuts_view",
    ]);
  });

  it("apple_shortcuts_list returns enveloped shortcut names (happy path)", async () => {
    const { client, calls } = await connect({
      list: { stdout: "Morning Briefing\nSend Message\n", stderr: "", exitCode: 0 },
    });
    const result = await client.callTool("apple_shortcuts_list", {});
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("Shortcuts (2):");
    expect(result.text).toContain(ENVELOPE_OPEN + 'list">');
    expect(result.text).toContain("Morning Briefing");
    expect(result.text).toContain(ENVELOPE_CLOSE);
    expect(calls[0]).toEqual(["list"]);
  });

  it("apple_shortcuts_list surfaces CLI failure as an enveloped error", async () => {
    const { client } = await connect({
      list: { stdout: "", stderr: "folder not found", exitCode: 1 },
    });
    const result = await client.callTool("apple_shortcuts_list", { folder_name: "Nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("exit 1");
    expect(result.text).toContain(ENVELOPE_OPEN + 'list">');
    expect(result.text).toContain("folder not found");
  });

  it("apple_shortcuts_run returns enveloped stdout (happy path)", async () => {
    const { client, calls } = await connect({
      run: { stdout: "the weather is fine", stderr: "", exitCode: 0 },
    });
    const result = await client.callTool("apple_shortcuts_run", { name: "Weather" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain(ENVELOPE_OPEN + 'run">');
    expect(result.text).toContain("the weather is fine");
    expect(calls[0]).toEqual(["run", "Weather"]);
  });

  it("apple_shortcuts_run reports CLI failure with enveloped stderr", async () => {
    const { client } = await connect({
      run: { stdout: "", stderr: "no such shortcut", exitCode: 1 },
    });
    const result = await client.callTool("apple_shortcuts_run", { name: "Ghost" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Failed to run shortcut "Ghost" (exit 1)');
    expect(result.text).toContain("no such shortcut");
    expect(result.text).toContain(ENVELOPE_CLOSE);
  });

  it("apple_shortcuts_run reports a timed-out run", async () => {
    const { client } = await connect({
      run: { stdout: "", stderr: "", exitCode: 1, timedOut: true },
    });
    const result = await client.callTool("apple_shortcuts_run", { name: "Dialog" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("did not finish within");
    expect(result.text).toContain("APPLE_SHORTCUTS_TIMEOUT_MS");
  });

  it("apple_shortcuts_view opens the editor (happy path)", async () => {
    const { client, calls } = await connect({
      view: { stdout: "", stderr: "", exitCode: 0 },
    });
    const result = await client.callTool("apple_shortcuts_view", { name: "Weather" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('Opened shortcut "Weather" in the Shortcuts app editor.');
    expect(calls[0]).toEqual(["view", "Weather"]);
  });

  it("apple_shortcuts_view surfaces CLI failure as an enveloped error", async () => {
    const { client } = await connect({
      view: { stdout: "", stderr: "shortcut not found", exitCode: 1 },
    });
    const result = await client.callTool("apple_shortcuts_view", { name: "Ghost" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("shortcut not found");
    expect(result.text).toContain(ENVELOPE_OPEN + 'view">');
  });

  it("rejects invalid input via Zod validation", async () => {
    const { client } = await connect({});
    const result = await client.callTool("apple_shortcuts_run", {});
    expect(result.isError).toBe(true);
  });
});
