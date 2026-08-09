/**
 * The exported handler factories are public API surface for embedders, who do
 * not get the MCP SDK's input validation. Each factory must parse its input
 * against the strict Zod schema itself (fail-closed) and must not invoke the
 * runner when validation fails.
 */

import { describe, it, expect } from "vitest";

import {
  createListShortcutsHandler,
  createRunShortcutHandler,
  createViewShortcutHandler,
  type ShortcutsRunner,
} from "../dist/index.js";

function recordingRunner() {
  const calls: string[][] = [];
  const runner: ShortcutsRunner = async (argv) => {
    calls.push([...argv]);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runner, calls };
}

describe("exported handler factories validate input fail-closed", () => {
  it("run rejects a missing name without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await expect(
      // @ts-expect-error deliberately invalid input from an untyped caller
      createRunShortcutHandler(runner)({ input: "hello" })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("run rejects an empty name without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await expect(createRunShortcutHandler(runner)({ name: "" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("run rejects unknown fields without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await expect(
      // @ts-expect-error deliberately invalid input from an untyped caller
      createRunShortcutHandler(runner)({ name: "X", path: "/etc/passwd" })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("run rejects a non-string input without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await expect(
      // @ts-expect-error deliberately invalid input from an untyped caller
      createRunShortcutHandler(runner)({ name: "X", input: 42 })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("view rejects a missing name without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    // @ts-expect-error deliberately invalid input from an untyped caller
    await expect(createViewShortcutHandler(runner)({})).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("list rejects a non-string folder_name without invoking the runner", async () => {
    const { runner, calls } = recordingRunner();
    await expect(
      // @ts-expect-error deliberately invalid input from an untyped caller
      createListShortcutsHandler(runner)({ folder_name: 7 })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("valid input still reaches the runner", async () => {
    const { runner, calls } = recordingRunner();
    await createRunShortcutHandler(runner)({ name: "Weather" });
    expect(calls).toEqual([["run", "--", "Weather"]]);
  });
});
