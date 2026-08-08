import { describe, expect, it, vi } from "vitest";

// ToolFactory is wired to the tool index modules; mock them with stand-in
// tools so this test exercises only the registration wiring, not the Xero
// API layer (which other tests cover with mocked handlers).
const { createHandler, updateHandler, deleteHandler, addNoteHandler, getHistoryHandler } =
  vi.hoisted(() => ({
    createHandler: vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "created" }],
    }),
    updateHandler: vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "updated" }],
    }),
    deleteHandler: vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "deleted" }],
    }),
    addNoteHandler: vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "noted" }],
    }),
    getHistoryHandler: vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "history" }],
    }),
  }));

vi.mock("../src/tools/create/index.js", () => ({
  CreateTools: [
    () => ({
      name: "create-invoice",
      description: "create",
      schema: {},
      handler: createHandler,
    }),
  ],
}));
vi.mock("../src/tools/update/index.js", () => ({
  UpdateTools: [
    () => ({
      name: "update-invoice",
      description: "update",
      schema: {},
      handler: updateHandler,
    }),
  ],
}));
vi.mock("../src/tools/delete/index.js", () => ({
  DeleteTools: [
    () => ({
      name: "delete-payroll-timesheet",
      description: "delete",
      schema: {},
      handler: deleteHandler,
    }),
  ],
}));
vi.mock("../src/tools/history/index.js", () => ({
  HistoryTools: [
    () => ({
      name: "add-invoice-note",
      description: "add note",
      schema: {},
      handler: addNoteHandler,
    }),
    () => ({
      name: "get-invoice-history",
      description: "get history",
      schema: {},
      handler: getHistoryHandler,
    }),
  ],
}));
vi.mock("../src/tools/get/index.js", () => ({ GetTools: [] }));
vi.mock("../src/tools/list/index.js", () => ({ ListTools: [] }));

import { ToolFactory } from "../src/tools/tool-factory.js";

interface RegisteredTool {
  name: string;
  annotations: Record<string, boolean>;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

function registerTools(): Map<string, RegisteredTool> {
  const registered = new Map<string, RegisteredTool>();
  const fakeServer = {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      annotations: Record<string, boolean>,
      handler: RegisteredTool["handler"],
    ) => {
      registered.set(name, { name, annotations, handler });
    },
  };
  ToolFactory(fakeServer as never);
  return registered;
}

describe("ToolFactory write tools", () => {
  it("runs write tools by default, with no opt-in environment variable", async () => {
    const registered = registerTools();

    for (const [name, handler] of [
      ["create-invoice", createHandler],
      ["update-invoice", updateHandler],
      ["delete-payroll-timesheet", deleteHandler],
      ["add-invoice-note", addNoteHandler],
    ] as const) {
      const tool = registered.get(name);
      expect(tool, `${name} should be registered`).toBeDefined();

      const result = (await tool!.handler({}, {})) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };

      expect(handler, `${name} handler should run`).toHaveBeenCalled();
      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).not.toContain("refuses to run");
    }
  });

  it("annotates write tools as destructive and read-only history tools as read-only", () => {
    const registered = registerTools();

    expect(registered.get("create-invoice")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(registered.get("get-invoice-history")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });
});
