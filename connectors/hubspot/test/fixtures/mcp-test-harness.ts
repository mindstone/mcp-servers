import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export interface McpTestConfig {
  name: string;
  serverScript?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  connectTimeout?: number;
}

export interface McpTestClient {
  listTools(): Promise<Tool[]>;
  getServerVersion(): { name: string; version: string } | undefined;
  callToolJson<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  callToolText(name: string, args?: Record<string, unknown>): Promise<string>;
  callToolRaw(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONNECTOR_ROOT = resolve(__dirname, '..', '..');

export function resolveServerScript(_name?: string): string {
  return join(CONNECTOR_ROOT, 'dist', 'index.js');
}

export async function createMcpTestClient(config: McpTestConfig): Promise<McpTestClient> {
  const {
    name,
    serverScript = resolveServerScript(name),
    command,
    args = [],
    env = {},
    connectTimeout = 10_000
  } = config;

  const spawnCommand = command ?? 'node';
  const usesExplicitCommand = typeof command === 'string';
  const spawnArgs = usesExplicitCommand ? args : [serverScript, ...args];

  if (!usesExplicitCommand && !existsSync(serverScript)) {
    throw new Error(`[${name}] Server script not found: ${serverScript}. Run npm run build first.`);
  }

  const transport = new StdioClientTransport({
    command: spawnCommand,
    args: spawnArgs,
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: 'test',
      ...env
    }
  });
  const client = new Client({ name: `${name}-test`, version: '1.0.0' });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const connectPromise = client.connect(transport);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`[${name}] Connection timeout after ${connectTimeout}ms`));
      }, connectTimeout);
    });
    await Promise.race([connectPromise, timeoutPromise]);
    clearTimeout(timeoutId);
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      await transport.close();
    } catch {
      // noop
    }
    throw error;
  }

  return {
    async listTools(): Promise<Tool[]> {
      const result = await client.listTools();
      return result.tools;
    },
    getServerVersion(): { name: string; version: string } | undefined {
      const serverVersion = client.getServerVersion();
      if (!serverVersion) return undefined;
      return {
        name: serverVersion.name,
        version: serverVersion.version,
      };
    },
    async callToolJson<T = unknown>(toolName: string, toolArgs?: Record<string, unknown>): Promise<T> {
      const text = await this.callToolText(toolName, toolArgs);
      return JSON.parse(text) as T;
    },
    async callToolText(toolName: string, toolArgs?: Record<string, unknown>): Promise<string> {
      const result = await this.callToolRaw(toolName, toolArgs);
      const textContent = result.content.find(
        (content): content is { type: 'text'; text: string } => content.type === 'text'
      );
      if (!textContent) {
        throw new Error(`[${name}] Tool "${toolName}" returned no text content`);
      }
      return textContent.text;
    },
    async callToolRaw(toolName: string, toolArgs?: Record<string, unknown>): Promise<CallToolResult> {
      const result = await client.callTool({
        name: toolName,
        arguments: toolArgs ?? {}
      });
      return result as CallToolResult;
    },
    async close(): Promise<void> {
      try {
        await client.close();
      } finally {
        try {
          await transport.close();
        } catch {
          // noop
        }
      }
    }
  };
}

export interface MockRoute {
  method?: string;
  path: string;
  handler: MockRouteHandler;
}

export type MockRouteHandler =
  | { status?: number; body: unknown }
  | ((req: MockRequest) => MockRouteResponse | Promise<MockRouteResponse>);

export interface MockRouteResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  rawBody?: string;
}

export interface MockRequest {
  method: string;
  url: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockApiServer {
  port: number;
  requestLog: MockRequest[];
  close(): Promise<void>;
  clearLog(): void;
}

export interface MockApiTestConfig extends Omit<McpTestConfig, 'command' | 'args'> {
  serverScript?: string;
  interceptDomains: string[];
  routes: MockRoute[];
}

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', rejectBody);
  });
}

export async function createMockApiServer(routes: MockRoute[]): Promise<MockApiServer> {
  const routeMap = new Map<string, MockRouteHandler>();
  for (const route of routes) {
    routeMap.set(routeKey(route.method ?? 'GET', route.path), route.handler);
  }

  const requestLog: MockRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', 'http://localhost');
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);

    let parsedBody: unknown = null;
    if (hasBody) {
      try {
        const rawBody = await readRequestBody(req);
        parsedBody = rawBody.length > 0 ? JSON.parse(rawBody) : null;
      } catch {
        parsedBody = null;
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }

    const mockRequest: MockRequest = {
      method,
      url: req.url || '/',
      pathname: url.pathname,
      searchParams: url.searchParams,
      headers,
      body: parsedBody
    };
    requestLog.push(mockRequest);

    const handler = routeMap.get(routeKey(method, url.pathname));
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found', method, pathname: url.pathname }));
      return;
    }

    try {
      const response: MockRouteResponse = typeof handler === 'function'
        ? await handler(mockRequest)
        : { status: handler.status, body: handler.body };
      res.statusCode = response.status ?? 200;
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          res.setHeader(key, value);
        }
      } else {
        res.setHeader('Content-Type', 'application/json');
      }
      if (response.rawBody !== undefined) {
        res.end(response.rawBody);
      } else {
        res.end(JSON.stringify(response.body));
      }
    } catch (error) {
      // Test fixture: surface a generic message to the wire and log the real
      // error to stderr for the developer running the tests. Avoids leaking
      // stack-trace / internal-state details into the response body even in
      // the unlikely case the harness is ever pointed at a non-test consumer.
      // eslint-disable-next-line no-console
      console.error('[mcp-test-harness] mock handler threw:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Mock handler error' }));
    }
  });

  const port = await new Promise<number>((resolvePort, rejectPort) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectPort(new Error('Unable to resolve mock server address'));
        return;
      }
      resolvePort(address.port);
    });
  });

  return {
    port,
    requestLog,
    close(): Promise<void> {
      return new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
    clearLog(): void {
      requestLog.length = 0;
    }
  };
}

function generateFetchRedirectWrapper(
  serverScriptPath: string,
  mockPort: number,
  interceptDomains: string[]
): string {
  const wrapperPath = join(tmpdir(), `hubspot-mock-wrapper-${process.pid}-${Date.now()}.mjs`);
  const serverScriptUrl = pathToFileURL(serverScriptPath).href;

  const wrapperCode = [
    `const MOCK_PORT = ${mockPort};`,
    `const INTERCEPT_DOMAINS = ${JSON.stringify(interceptDomains)};`,
    'const originalFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init) => {',
    "  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);",
    '  if (INTERCEPT_DOMAINS.some((domain) => url.includes(domain))) {',
    '    const parsed = new URL(url);',
    "    const redirected = `http://127.0.0.1:${MOCK_PORT}${parsed.pathname}${parsed.search}`;",
    "    if (typeof input === 'object' && !(input instanceof URL)) {",
    '      return originalFetch(new Request(redirected, input), init);',
    '    }',
    '    return originalFetch(redirected, init);',
    '  }',
    '  return originalFetch(input, init);',
    '};',
    `await import('${serverScriptUrl}');`
  ].join('\n');

  writeFileSync(wrapperPath, wrapperCode, 'utf-8');
  return wrapperPath;
}

export async function createMcpTestClientWithMockApi(
  config: MockApiTestConfig
): Promise<{ client: McpTestClient; mockApi: MockApiServer }> {
  const {
    name,
    serverScript = resolveServerScript(name),
    interceptDomains,
    routes,
    env = {},
    connectTimeout
  } = config;

  const mockApi = await createMockApiServer(routes);
  const wrapperPath = generateFetchRedirectWrapper(serverScript, mockApi.port, interceptDomains);

  try {
    const rawClient = await createMcpTestClient({
      name,
      command: 'node',
      args: [wrapperPath],
      env,
      connectTimeout,
      serverScript
    });
    const client: McpTestClient = {
      ...rawClient,
      async close(): Promise<void> {
        try {
          await rawClient.close();
        } finally {
          try {
            unlinkSync(wrapperPath);
          } catch {
            // noop
          }
        }
      }
    };
    return { client, mockApi };
  } catch (error) {
    try {
      await mockApi.close();
    } catch {
      // noop
    }
    try {
      unlinkSync(wrapperPath);
    } catch {
      // noop
    }
    throw error;
  }
}
