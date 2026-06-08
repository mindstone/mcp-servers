import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { CreateTools } from "./create/index.js";
import { DeleteTools } from "./delete/index.js";
import { GetTools } from "./get/index.js";
import { HistoryTools } from "./history/index.js";
import { ListTools } from "./list/index.js";
import { UpdateTools } from "./update/index.js";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
};

export function ToolFactory(server: McpServer) {
  DeleteTools.map((tool) => tool()).forEach((tool) =>
    server.tool(tool.name, tool.description, tool.schema, WRITE_ANNOTATIONS, tool.handler),
  );
  GetTools.map((tool) => tool()).forEach((tool) =>
    server.tool(tool.name, tool.description, tool.schema, READ_ONLY_ANNOTATIONS, tool.handler),
  );
  CreateTools.map((tool) => tool()).forEach((tool) =>
    server.tool(tool.name, tool.description, tool.schema, WRITE_ANNOTATIONS, tool.handler),
  );
  HistoryTools.map((tool) => tool()).forEach((tool) =>
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      tool.name.startsWith("get-") ? READ_ONLY_ANNOTATIONS : WRITE_ANNOTATIONS,
      tool.handler,
    ),
  );
  ListTools.map((tool) => tool()).forEach((tool) =>
    server.tool(tool.name, tool.description, tool.schema, READ_ONLY_ANNOTATIONS, tool.handler),
  );
  UpdateTools.map((tool) => tool()).forEach((tool) =>
    server.tool(tool.name, tool.description, tool.schema, WRITE_ANNOTATIONS, tool.handler),
  );
}
