/**
 * VAL-APPLESC-001..006 — `apple_shortcuts_run` `input` parameter must be
 * treated as text, written to a `0o600`-mode temp file under `os.tmpdir()`,
 * and the resulting path passed to `shortcuts run --input-path`. The temp
 * file must be unlinked in a `finally` block on every exit path.
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createRunShortcutHandler,
  type ShortcutsRunner,
  type ShortcutsRunResult,
} from "../dist/index.js";

function listTempEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith("apple-sc-"));
}

describe("VAL-APPLESC-001 — input text is written to a temp file and that path is passed to --input-path", () => {
  it("argv carries an absolute path under os.tmpdir() whose contents equal the input text", async () => {
    let capturedArgv: string[] | undefined;
    let capturedInputAtSpawn: string | undefined;
    let capturedTempPath: string | undefined;
    let capturedTempParentRealpath: string | undefined;

    const fakeRunner: ShortcutsRunner = async (argv) => {
      capturedArgv = [...argv];
      const idx = argv.indexOf("--input-path");
      if (idx !== -1) {
        capturedTempPath = argv[idx + 1];
        capturedInputAtSpawn = fs.readFileSync(capturedTempPath, "utf8");
        capturedTempParentRealpath = fs.realpathSync(path.dirname(capturedTempPath));
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createRunShortcutHandler(fakeRunner);
    const result = await handler({ name: "Echo", input: "hello-from-test" });

    assert.ok(capturedArgv, "runner was not invoked");
    assert.strictEqual(capturedArgv?.[0], "run");
    assert.deepEqual(capturedArgv?.slice(-2), ["--", "Echo"]);
    const idx = capturedArgv!.indexOf("--input-path");
    assert.ok(idx >= 0, "argv must contain --input-path");
    const tempPath = capturedArgv![idx + 1];
    assert.ok(tempPath, "argv must include a value after --input-path");
    assert.ok(path.isAbsolute(tempPath), `expected absolute path, got ${tempPath}`);
    const tmp = fs.realpathSync(os.tmpdir());
    assert.ok(
      capturedTempParentRealpath !== undefined &&
        capturedTempParentRealpath.startsWith(tmp),
      `temp path ${tempPath} must live under ${tmp}; parent realpath was ${capturedTempParentRealpath}`
    );
    assert.notStrictEqual(tempPath, "hello-from-test");
    assert.strictEqual(capturedInputAtSpawn, "hello-from-test");

    // Sanity: the handler does not error on the success path.
    assert.ok(!("isError" in result) || result.isError !== true);

    // tempPath used so lint doesn't warn about unused var.
    assert.strictEqual(capturedTempPath, tempPath);
  });
});

describe("VAL-APPLESC-002 — temp file mode is 0o600", () => {
  it("file at --input-path has mode 0o600 at spawn time", async () => {
    let observedMode: number | undefined;

    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      assert.ok(idx >= 0);
      const tempPath = argv[idx + 1];
      observedMode = fs.statSync(tempPath).mode & 0o777;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const handler = createRunShortcutHandler(fakeRunner);
    await handler({ name: "Echo", input: "secret" });

    assert.strictEqual(observedMode, 0o600);
  });
});

describe("VAL-APPLESC-003 — cleanup on success", () => {
  it("temp file is unlinked after a successful spawn", async () => {
    let tempPath: string | undefined;

    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      tempPath = argv[idx + 1];
      assert.ok(fs.existsSync(tempPath), "temp file must exist at spawn time");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createRunShortcutHandler(fakeRunner);
    await handler({ name: "Echo", input: "hello" });

    assert.ok(tempPath);
    assert.strictEqual(fs.existsSync(tempPath!), false);
  });
});

describe("VAL-APPLESC-004 — cleanup on shortcut failure", () => {
  it("temp file is unlinked after a non-zero exit code", async () => {
    let tempPath: string | undefined;

    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      tempPath = argv[idx + 1];
      return { stdout: "", stderr: "boom", exitCode: 1 } satisfies ShortcutsRunResult;
    };

    const handler = createRunShortcutHandler(fakeRunner);
    const result = await handler({ name: "Echo", input: "hello" });

    assert.ok(tempPath);
    assert.strictEqual(fs.existsSync(tempPath!), false);
    assert.strictEqual((result as { isError?: boolean }).isError, true);
  });
});

describe("VAL-APPLESC-005 — cleanup on spawn-thrown error", () => {
  it("temp file is still unlinked when the runner rejects", async () => {
    let tempPath: string | undefined;

    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      tempPath = argv[idx + 1];
      throw new Error("ENOENT: shortcuts CLI missing");
    };

    const handler = createRunShortcutHandler(fakeRunner);
    await assert.rejects(() => handler({ name: "Echo", input: "secret" }), /ENOENT/);

    assert.ok(tempPath);
    assert.strictEqual(fs.existsSync(tempPath!), false);
  });
});

describe("VAL-APPLESC-006 — no input → no temp file, no --input-path", () => {
  it("argv omits --input-path and no apple-sc-* entry leaks under os.tmpdir()", async () => {
    let capturedArgv: string[] | undefined;
    const before = new Set(listTempEntries());

    const fakeRunner: ShortcutsRunner = async (argv) => {
      capturedArgv = [...argv];
      return { stdout: "no-output", stderr: "", exitCode: 0 };
    };

    const handler = createRunShortcutHandler(fakeRunner);
    await handler({ name: "Echo" });

    assert.ok(capturedArgv);
    assert.strictEqual(capturedArgv!.includes("--input-path"), false);

    const after = listTempEntries();
    const created = after.filter((e) => !before.has(e));
    assert.deepEqual(
      created,
      [],
      `no apple-sc-* entries should be created when input is omitted; saw ${created.join(",")}`
    );
  });
});

describe("VAL-APPLESC-301 — every input branch leaves os.tmpdir() clean (regression)", () => {
  it("repeated invocations do not leak apple-sc-* directories", async () => {
    const before = new Set(listTempEntries());

    const ok: ShortcutsRunner = async () => ({ stdout: "ok", stderr: "", exitCode: 0 });
    const fail: ShortcutsRunner = async () => ({ stdout: "", stderr: "x", exitCode: 1 });
    const throwy: ShortcutsRunner = async () => {
      throw new Error("spawn boom");
    };

    await createRunShortcutHandler(ok)({ name: "A", input: "1" });
    await createRunShortcutHandler(fail)({ name: "B", input: "2" });
    await assert.rejects(() => createRunShortcutHandler(throwy)({ name: "C", input: "3" }));
    await createRunShortcutHandler(ok)({ name: "D" }); // no input branch

    const after = listTempEntries();
    const leaked = after.filter((e) => !before.has(e));
    assert.deepEqual(leaked, [], `leftover apple-sc-* entries: ${leaked.join(",")}`);
  });
});

describe("VAL-APPLESC-302 — cleanup failure is observable, not silent", () => {
  it("logs a warning when the temp file cannot be removed", async () => {
    // Simulate a genuinely failing unlink: replace the temp file with a
    // directory of the same name so unlinkSync throws EISDIR (Linux) / EPERM
    // (macOS) — a real failure, unlike ENOENT, which is benign and
    // intentionally silent (see VAL-APPLESC-303).
    let tempPath: string | undefined;
    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      tempPath = argv[idx + 1];
      fs.unlinkSync(tempPath);
      fs.mkdirSync(tempPath);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createRunShortcutHandler(fakeRunner)({ name: "Echo", input: "hi" });
      assert.ok(!("isError" in result) || result.isError !== true);

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      assert.ok(
        logged.includes("Failed to remove temporary shortcut input file"),
        `expected a cleanup-failure warning; got: ${logged}`
      );
      // The raw fs error message embeds the temp path, which must not reach
      // log files — the warning carries the errno instead.
      assert.ok(tempPath);
      assert.ok(!logged.includes(tempPath!), `temp path leaked into logs; got: ${logged}`);
      assert.ok(logged.includes("EISDIR") || logged.includes("EPERM"));
    } finally {
      errSpy.mockRestore();
      // The handler's rmdirSync fails on the non-empty dir; clean up manually.
      if (tempPath !== undefined) {
        fs.rmSync(tempPath, { recursive: true, force: true });
        fs.rmdirSync(path.dirname(tempPath));
      }
    }
  });
});

describe("VAL-APPLESC-303 — a failed temp-file write raises no spurious cleanup warning", () => {
  it("rejects, stays silent about cleanup, and leaves no apple-sc-* entries", async () => {
    const before = new Set(listTempEntries());
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated write failure");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const runner: ShortcutsRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });
      await assert.rejects(
        () => createRunShortcutHandler(runner)({ name: "Echo", input: "hi" }),
        /simulated write failure/
      );

      // The unlink hits ENOENT because the file was never created; that is
      // benign and must not warn (nothing is at rest).
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      assert.ok(
        !logged.includes("Failed to remove temporary shortcut input file"),
        `spurious cleanup warning fired; got: ${logged}`
      );

      const leaked = listTempEntries().filter((e) => !before.has(e));
      assert.deepEqual(leaked, [], `leftover apple-sc-* entries: ${leaked.join(",")}`);
    } finally {
      writeSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe("VAL-APPLESC-304 — a temp file that vanishes after a successful write still warns", () => {
  it("ENOENT during cleanup is only silenced when the write never created the file", async () => {
    // Simulate an external actor removing the file mid-run: the unlink hits
    // ENOENT, but the file DID exist — it may have been moved rather than
    // deleted, leaving user input at rest elsewhere, so this must warn.
    const fakeRunner: ShortcutsRunner = async (argv) => {
      const idx = argv.indexOf("--input-path");
      fs.unlinkSync(argv[idx + 1]);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createRunShortcutHandler(fakeRunner)({ name: "Echo", input: "hi" });
      assert.ok(!("isError" in result) || result.isError !== true);

      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      assert.ok(
        logged.includes("Failed to remove temporary shortcut input file"),
        `expected a cleanup-failure warning; got: ${logged}`
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("VAL-APPLESC-007 — `--` end-of-options separator precedes the shortcut name", () => {
  it("options come first, then `--`, then the name — even one starting with `-`", async () => {
    let capturedArgv: string[] | undefined;
    const fakeRunner: ShortcutsRunner = async (argv) => {
      capturedArgv = [...argv];
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const handler = createRunShortcutHandler(fakeRunner);
    await handler({ name: "--help", input: "hi" });

    assert.ok(capturedArgv, "runner was not invoked");
    assert.strictEqual(capturedArgv![0], "run");
    // Options must precede `--`: anything after it is parsed as positional.
    assert.strictEqual(capturedArgv![1], "--input-path");
    assert.deepEqual(capturedArgv!.slice(-2), ["--", "--help"]);
  });
});
