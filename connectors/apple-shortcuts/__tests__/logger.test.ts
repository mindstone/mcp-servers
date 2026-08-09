/**
 * Regression — `logger.warn` (and `info`/`debug`) routed an `Error` payload
 * through `JSON.stringify`, which serializes it as '{}' and silently drops
 * the message (e.g. the cause of a temp-file cleanup failure). Error payloads
 * must log their redacted message instead, matching `logger.error`.
 */

import { describe, it, vi } from "vitest";
import assert from "node:assert";

import * as logger from "../dist/logger.js";

describe("logger Error serialization", () => {
  it("warn logs the redacted Error message, not '{}'", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.warn("cleanup failed", new Error("disk full; token=abc123"));
      const logged = spy.mock.calls.map((c) => c.join(" ")).join("\n");
      assert.ok(logged.includes("cleanup failed"));
      assert.ok(logged.includes("disk full"), `expected the error message; got: ${logged}`);
      assert.ok(!logged.includes("{}"), `error message was dropped; got: ${logged}`);
      // The credential-redaction patterns still apply to Error messages.
      assert.ok(!logged.includes("abc123"), `token leaked into logs; got: ${logged}`);
      assert.ok(logged.includes("[REDACTED]"));
    } finally {
      spy.mockRestore();
    }
  });
});
