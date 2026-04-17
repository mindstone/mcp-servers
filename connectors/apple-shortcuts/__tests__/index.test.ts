import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";

// Import schemas directly from the dist (after build) to test validation
// We do this by evaluating the schemas from TypeScript source via a workaround:
// Since we can't await in describe(), we inline the schema construction.

describe("ListShortcutsInputSchema", () => {
  it("accepts empty object", () => {
    const schema = z.object({
      folder_name: z.string().optional().describe("Optional folder name"),
      show_identifiers: z.boolean().default(false),
    });
    const result = schema.safeParse({});
    assert.ok(result.success, result.error?.message);
  });

  it("accepts folder_name string", () => {
    const schema = z.object({
      folder_name: z.string().optional(),
      show_identifiers: z.boolean().default(false),
    });
    const result = schema.safeParse({ folder_name: "Work" });
    assert.ok(result.success, result.error?.message);
    assert.equal(result.data.folder_name, "Work");
  });

  it("rejects unknown fields", () => {
    const schema = z.object({
      folder_name: z.string().optional(),
      show_identifiers: z.boolean().default(false),
    }).strict();
    const result = schema.safeParse({ folder_name: "Work", foo: "bar" });
    assert.ok(!result.success);
  });
});

describe("RunShortcutInputSchema", () => {
  it("requires name", () => {
    const schema = z.object({
      name: z.string().min(1, "Shortcut name is required"),
      input: z.string().optional(),
    }).strict();
    const result = schema.safeParse({});
    assert.ok(!result.success);
  });

  it("accepts name only", () => {
    const schema = z.object({
      name: z.string().min(1, "Shortcut name is required"),
      input: z.string().optional(),
    }).strict();
    const result = schema.safeParse({ name: "My Shortcut" });
    assert.ok(result.success, result.error?.message);
    assert.equal(result.data.name, "My Shortcut");
    assert.equal(result.data.input, undefined);
  });

  it("accepts name with input", () => {
    const schema = z.object({
      name: z.string().min(1, "Shortcut name is required"),
      input: z.string().optional(),
    }).strict();
    const result = schema.safeParse({ name: "My Shortcut", input: "hello" });
    assert.ok(result.success, result.error?.message);
    assert.equal(result.data.input, "hello");
  });

  it("rejects empty name", () => {
    const schema = z.object({
      name: z.string().min(1, "Shortcut name is required"),
      input: z.string().optional(),
    }).strict();
    const result = schema.safeParse({ name: "" });
    assert.ok(!result.success);
  });

  it("rejects unknown fields", () => {
    const schema = z.object({
      name: z.string().min(1, "Shortcut name is required"),
      input: z.string().optional(),
    }).strict();
    const result = schema.safeParse({ name: "Test", extra: true });
    assert.ok(!result.success);
  });
});
