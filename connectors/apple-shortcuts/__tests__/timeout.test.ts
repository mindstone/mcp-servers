/**
 * Timeout behavior for `runShortcuts`: a hung `shortcuts` CLI invocation must
 * be terminated (SIGTERM, then SIGKILL after a grace period) and reported with
 * `timedOut: true`, instead of blocking the tool call forever.
 *
 * `child_process.spawn` is mocked — the real `shortcuts` CLI only exists on
 * macOS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { runShortcuts, resolveTimeoutMs, DEFAULT_TIMEOUT_MS } from "../dist/index.js";

type Handler = (...args: unknown[]) => void;

function createFakeProc() {
  const handlers: Record<string, Handler[]> = {};
  const killed: string[] = [];
  return {
    killed,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on(event: string, cb: Handler) {
      (handlers[event] ??= []).push(cb);
    },
    kill(signal?: string) {
      killed.push(signal ?? "SIGTERM");
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
  };
}

const spawnMock = vi.mocked(spawn);

describe("resolveTimeoutMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 120000ms when unset", () => {
    delete process.env.APPLE_SHORTCUTS_TIMEOUT_MS;
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("parses a valid numeric override", () => {
    expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "30000" })).toBe(30000);
  });

  it("falls back to the default for non-numeric or non-positive values", () => {
    expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "abc" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "0" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "-5" })).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("does not echo the raw invalid value into logs (may carry secret material)", () => {
    // Credential-shaped fixture built programmatically — never a literal.
    const secretShaped = "sk-" + "a1b2c3".repeat(6);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: secretShaped })).toBe(
        DEFAULT_TIMEOUT_MS
      );
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("Invalid APPLE_SHORTCUTS_TIMEOUT_MS");
      expect(logged).not.toContain(secretShaped);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("runShortcuts timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("APPLE_SHORTCUTS_TIMEOUT_MS", "1000");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    spawnMock.mockReset();
  });

  it("sends SIGTERM at the timeout, escalates to SIGKILL after the grace period, and reports timedOut", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["run", "Hanging"]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(proc.killed).toEqual(["SIGTERM"]);

    // Process ignores SIGTERM; SIGKILL follows after the grace period.
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);

    proc.emit("close", null);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("does not escalate to SIGKILL when the process exits after SIGTERM", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["run", "Slow"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(proc.killed).toEqual(["SIGTERM"]);

    proc.emit("close", null);
    await vi.advanceTimersByTimeAsync(10000);
    expect(proc.killed).toEqual(["SIGTERM"]);

    const result = await pending;
    expect(result.timedOut).toBe(true);
  });

  it("returns normally with no kill when the process exits before the timeout", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["list"]);
    proc.emit("close", 0);
    const result = await pending;

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(result.timedOut).toBeUndefined();
    expect(proc.killed).toEqual([]);
  });

  it("timeout warning logs only the subcommand, never the shortcut name or input path", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = runShortcuts([
        "run",
        "Private Family Matters",
        "--input-path",
        "/tmp/apple-sc-secret/input.txt",
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      proc.emit("close", null);
      await pending;

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain('"shortcuts run"');
      expect(logged).not.toContain("Private Family Matters");
      expect(logged).not.toContain("apple-sc-secret");
    } finally {
      errSpy.mockRestore();
    }
  });
});
