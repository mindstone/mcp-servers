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

function createFakeProc(opts: { killResult?: boolean } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const killed: string[] = [];
  const register = (key: string) => (event: string, cb: Handler) => {
    (handlers[`${key}:${event}`] ??= []).push(cb);
  };
  return {
    killed,
    stdout: { on: register("stdout") },
    stderr: { on: register("stderr") },
    on(event: string, cb: Handler) {
      (handlers[event] ??= []).push(cb);
    },
    kill(signal?: string) {
      killed.push(signal ?? "SIGTERM");
      return opts.killResult ?? true;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
    emitData(stream: "stdout" | "stderr", text: string) {
      for (const cb of handlers[`${stream}:data`] ?? []) cb(Buffer.from(text));
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

  it("clamps sub-millisecond and timer-overflowing values into a valid range", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 0.5 floors to 0, which would fire the timeout immediately.
      expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "0.5" })).toBe(DEFAULT_TIMEOUT_MS);
      // Above 2^31-1 Node clamps the delay to 1ms — clamp to the top of the
      // valid timer range instead.
      expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "999999999999" })).toBe(
        2_147_483_647
      );
      expect(resolveTimeoutMs({ APPLE_SHORTCUTS_TIMEOUT_MS: "300000" })).toBe(300000);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("returns accumulated stdout/stderr when the run times out", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["run", "Chatterbox"]);
    proc.emitData("stdout", "partial-out");
    proc.emitData("stderr", "partial-err");
    await vi.advanceTimersByTimeAsync(1000);
    proc.emit("close", null);

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial-out");
    expect(result.stderr).toBe("partial-err");
  });

  it("bounds captured output and marks it truncated", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["list"]);
    proc.emitData("stdout", "x".repeat(1_500_000));
    proc.emitData("stdout", "y".repeat(100));
    proc.emitData("stderr", "e".repeat(1_500_000));
    proc.emit("close", 0);

    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThan(1_000_100);
    expect(result.stdout).toContain("[output truncated");
    expect(result.stdout).not.toContain("y");
    expect(result.stderr).toContain("[output truncated");
  });

  it("settles after a failed SIGTERM/SIGKILL delivery and no close event", async () => {
    const proc = createFakeProc({ killResult: false });
    spawnMock.mockReturnValue(proc as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pending = runShortcuts(["run", "Unkillable"]);
      proc.emitData("stdout", "kept-output");
      await vi.advanceTimersByTimeAsync(1000); // SIGTERM (fails)
      await vi.advanceTimersByTimeAsync(5000); // SIGKILL (fails)
      await vi.advanceTimersByTimeAsync(5000); // backstop settles

      const result = await pending;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("kept-output");

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("SIGTERM delivery failed");
      expect(logged).toContain("SIGKILL delivery failed");
      expect(logged).not.toContain("Unkillable");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("settles when the process never emits close after SIGKILL", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["run", "Ghost"]);
    await vi.advanceTimersByTimeAsync(1000); // SIGTERM
    await vi.advanceTimersByTimeAsync(5000); // SIGKILL
    expect(proc.killed).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(5000); // backstop settles without close

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it("an error event after the timeout settles the call exactly once", async () => {
    const proc = createFakeProc();
    spawnMock.mockReturnValue(proc as never);

    const pending = runShortcuts(["run", "Flaky"]);
    await vi.advanceTimersByTimeAsync(1000); // SIGTERM
    proc.emit("error", new Error("spawn blew up"));
    proc.emit("close", 1); // must be ignored after settling

    const result = await pending;
    expect(result.stderr).toBe("spawn blew up");
    expect(result.exitCode).toBe(1);
  });
});
