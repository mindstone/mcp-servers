import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";

/**
 * Largest single JSON-RPC message the server accepts on stdin.
 *
 * The MCP SDK caps stdio messages at 10 MiB by default and closes the
 * connection when a message is larger. Attachments travel inline as base64
 * (up to the 25 MiB attachment limit, about 33.4 MiB once encoded), so the
 * cap has to sit above that plus the JSON around it. The limit is per message,
 * not per attachment: a call carrying several large inline attachments can
 * still exceed it and drop the connection, so large files should be passed by
 * path instead.
 */
export const STDIO_MAX_MESSAGE_BYTES = 48 * 1024 * 1024;

export function createStdioTransport(stdin?: Readable, stdout?: Writable): StdioServerTransport {
  return new StdioServerTransport(stdin, stdout, { maxBufferSize: STDIO_MAX_MESSAGE_BYTES });
}
