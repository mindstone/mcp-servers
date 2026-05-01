import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { http as mswHttp, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createSalesforceHandlers,
  MOCK_ACCESS_TOKEN,
  MOCK_INSTANCE_URL,
} from './helpers/salesforce-mock-api.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone-engineering/mcp-test-harness';

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');
const TEST_DIR = path.resolve(import.meta.dirname);

function getAllFiles(dir: string, ext = '.ts'): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      files.push(...getAllFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      files.push(full);
    }
  }
  return files;
}

function readAllSourceFiles(): string {
  const srcFiles = getAllFiles(SRC_DIR);
  return srcFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
}

describe('Security audit — Salesforce MCP server', () => {
  it('source contains no internal references (mindstone/rebel/nspr)', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    // Exclude bridge.ts which has the standard legacy env var fallback per mcp-servers convention
    const nonBridgeFiles = srcFiles.filter((f) => !f.endsWith('bridge.ts'));
    const source = nonBridgeFiles.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');

    const patterns = [/mindstone/i, /\brebel\b/i, /\bnspr\b/i];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      expect(match, `Found internal reference: ${match?.[0]}`).toBeNull();
    }

    // bridge.ts: only the standard MINDSTONE_REBEL_BRIDGE_STATE legacy fallback is allowed
    const bridgeFile = srcFiles.find((f) => f.endsWith('bridge.ts'));
    if (bridgeFile) {
      const bridgeSource = fs.readFileSync(bridgeFile, 'utf-8');
      const lines = bridgeSource.split('\n').filter((l) => !l.includes('MINDSTONE_REBEL_BRIDGE_STATE'));
      const filtered = lines.join('\n');
      for (const pattern of patterns) {
        const match = filtered.match(pattern);
        expect(match, `bridge.ts has non-standard internal reference: ${match?.[0]}`).toBeNull();
      }
    }
  });

  it('source contains no host-specific bridge code', () => {
    const source = readAllSourceFiles();
    // The bridge.ts should use generic env vars, not host-specific paths
    expect(source).not.toContain('/bundled/salesforce/');
    expect(source).not.toContain('/bundled/');
  });

  it('source contains no hardcoded secrets', () => {
    const source = readAllSourceFiles();
    const secretPatterns = [
      /sk_live[a-zA-Z0-9_]+/,
      /sk_test[a-zA-Z0-9_]+/,
      /key_real[a-zA-Z0-9_]+/,
      /xoxb-[a-zA-Z0-9-]+/,
      /xoxp-[a-zA-Z0-9-]+/,
    ];
    for (const pattern of secretPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  it('error messages are host-neutral', () => {
    const source = readAllSourceFiles();
    // Error strings should not reference specific host apps
    const lines = source.split('\n');
    const errorLines = lines.filter((l) =>
      l.includes('throw new') || l.includes('error:') || l.includes('resolution:'),
    );
    const errorText = errorLines.join('\n').toLowerCase();
    expect(errorText).not.toContain('rebel');
    expect(errorText).not.toContain('mindstone');
  });

  it('all tool parameters use snake_case', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    const toolFiles = srcFiles.filter((f) => f.includes('/tools/'));
    const camelCaseParamPattern = /z\.object\(\{([^}]+)\}/g;

    for (const file of toolFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match;
      while ((match = camelCaseParamPattern.exec(content)) !== null) {
        const paramBlock = match[1];
        // Extract parameter names (keys before the colon in z.object)
        const paramNames = paramBlock.match(/(\w+)\s*:/g);
        if (paramNames) {
          for (const param of paramNames) {
            const name = param.replace(':', '').trim();
            // All param names should be snake_case or single-word lowercase
            expect(
              /^[a-z][a-z0-9_]*$/.test(name),
              `Parameter "${name}" in ${path.basename(file)} should be snake_case`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M3.2 — SOQL escaping + OAuth bind hardening (VAL-SALESFORCE-010..019)
// ---------------------------------------------------------------------------

function createAuthEnv(configPath: string): Record<string, string> {
  return {
    SALESFORCE_CLIENT_ID: 'mcp-test-client-id',
    SALESFORCE_CLIENT_SECRET: 'mcp-test-client-secret',
    SALESFORCE_CONFIG_DIR: configPath,
    MCP_HOST_BRIDGE_STATE: '',
  };
}

function createConfigWithToken() {
  return createTempConfig({
    accounts: [
      {
        id: 'test-user',
        username: 'test@example.com',
        connected_at: new Date().toISOString(),
      },
    ],
    credentials: [
      {
        filename: 'test-user.token.json',
        data: {
          access_token: MOCK_ACCESS_TOKEN,
          refresh_token: 'mock-refresh',
          instance_url: MOCK_INSTANCE_URL,
          expires_at: Date.now() + 3600_000,
          username: 'test@example.com',
        },
      },
    ],
  });
}

/**
 * Install an msw handler that captures every SOQL query string the connector
 * forwards to Salesforce, returning a canned empty response. Returns the
 * captured-query array (mutated as requests are observed).
 */
function captureSoqlQueries(): { queries: string[] } {
  const captured: string[] = [];
  const handler = mswHttp.get('*/services/data/*/query*', ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') ?? '';
    captured.push(q);
    // Return whatever shape jsforce expects; the existing fixture handler does
    // the same.
    return HttpResponse.json({ totalSize: 0, done: true, records: [] });
  });
  mswServer.use(handler, ...createSalesforceHandlers());
  return { queries: captured };
}

describe('M3.2 — SOQL escaping (VAL-SALESFORCE-010..014)', () => {
  it('VAL-SALESFORCE-010 — escapeSOQL escapes \\\\, \', %, _', async () => {
    const { escapeSOQL } = await import('../src/utils.js');
    expect(escapeSOQL("foo'bar")).toBe("foo''bar");
    expect(escapeSOQL('a\\b')).toBe('a\\\\b');
    expect(escapeSOQL('a%b')).toBe('a\\%b');
    expect(escapeSOQL('a_b')).toBe('a\\_b');
    expect(escapeSOQL('100% pure_value')).toBe('100\\% pure\\_value');
  });

  it('VAL-SALESFORCE-011 — escapeSOQLLike helper exists and escapes wildcards', async () => {
    const utils = await import('../src/utils.js');
    expect(typeof (utils as Record<string, unknown>).escapeSOQLLike).toBe('function');
    expect((utils as { escapeSOQLLike: (s: string) => string }).escapeSOQLLike('a%b')).toBe('a\\%b');
    expect((utils as { escapeSOQLLike: (s: string) => string }).escapeSOQLLike('a_b')).toBe('a\\_b');
    expect((utils as { escapeSOQLLike: (s: string) => string }).escapeSOQLLike("a'b")).toBe("a''b");
    expect((utils as { escapeSOQLLike: (s: string) => string }).escapeSOQLLike('a\\b')).toBe('a\\\\b');
  });

  it('VAL-SALESFORCE-012 — every LIKE %...% site uses escapeSOQLLike (static)', () => {
    const toolFiles = getAllFiles(path.join(SRC_DIR, 'tools'));
    const offendingLines: string[] = [];
    const goodSites: string[] = [];
    for (const file of toolFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (/LIKE\s*'%\$\{escapeSOQL\(/.test(line)) {
          offendingLines.push(`${path.basename(file)}: ${line.trim()}`);
        }
        if (/LIKE\s*'%\$\{escapeSOQLLike\(/.test(line)) {
          goodSites.push(`${path.basename(file)}: ${line.trim()}`);
        }
        // Also covers the contacts/leads two-arg LIKE site where the escape is
        // pre-computed into a local; check for any escapeSOQL( appearing in a
        // line that ALSO contains LIKE '%
        if (/LIKE\s*'%/.test(line) && /escapeSOQL\(/.test(line) && !/escapeSOQLLike\(/.test(line)) {
          offendingLines.push(`${path.basename(file)}: ${line.trim()}`);
        }
      }
    }
    expect(offendingLines, `Some LIKE sites still use escapeSOQL: ${offendingLines.join('\n')}`).toEqual([]);
    // Should have at least one escapeSOQLLike LIKE-site across the connector tree.
    expect(goodSites.length).toBeGreaterThan(0);
  });
});

describe('M3.2 — Captured SOQL escaping (VAL-SALESFORCE-013..016)', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('VAL-SALESFORCE-013 — literal % in name_contains is escaped at LIKE site', async () => {
    const { queries } = captureSoqlQueries();
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_contacts', {
      name_contains: '50%',
    });
    expect(result.json).toHaveProperty('ok', true);
    const soql = queries.find((q) => q.includes('FROM Contact'));
    expect(soql, `expected one SOQL query against Contact, got: ${queries.join(' | ')}`).toBeDefined();
    // Wildcard % around the literal escaped % token: '%50\%%'
    expect(soql).toContain("LIKE '%50\\%%'");
  });

  it('VAL-SALESFORCE-014 — literal _ in name_contains is escaped at LIKE site', async () => {
    const { queries } = captureSoqlQueries();
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_get_contacts', {
      name_contains: 'foo_bar',
    });
    expect(result.json).toHaveProperty('ok', true);
    const soql = queries.find((q) => q.includes('FROM Contact'));
    expect(soql).toBeDefined();
    expect(soql).toContain("LIKE '%foo\\_bar%'");
  });

  it('VAL-SALESFORCE-015 — salesforce_query LIMIT cap applied with OFFSET', async () => {
    const { queries } = captureSoqlQueries();
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const result = await testClient.callTool('salesforce_query', {
      query: 'SELECT Id FROM Contact LIMIT 5000 OFFSET 100',
    });
    expect(result.json).toHaveProperty('ok', true);
    const soql = queries.find((q) => q.includes('FROM Contact')) ?? '';
    // Exactly one LIMIT clause, capped to <= 200, with OFFSET preserved.
    const limitMatches = soql.match(/\bLIMIT\b/gi) ?? [];
    expect(limitMatches.length).toBe(1);
    const limitNum = soql.match(/\bLIMIT\s+(\d+)/i);
    expect(limitNum, `no LIMIT n in: ${soql}`).not.toBeNull();
    expect(parseInt(limitNum![1], 10)).toBeLessThanOrEqual(200);
    expect(soql).toMatch(/\bOFFSET\s+100\b/);
  });

  it('VAL-SALESFORCE-016 — LIMIT cap survives comments / whitespace bypass attempts', async () => {
    const variants = [
      'SELECT Id FROM Contact LIMIT 5000 // padding',
      'SELECT Id FROM Contact LIMIT 5000   ',
      'SELECT Id FROM Contact LIMIT 5000 /* comment */',
      'SELECT Id FROM Contact OFFSET 1000',
    ];
    for (const variant of variants) {
      const { queries } = captureSoqlQueries();
      tempConfig = createConfigWithToken();
      testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

      const result = await testClient.callTool('salesforce_query', { query: variant });
      expect(result.json, `variant: ${variant}`).toHaveProperty('ok', true);

      const soql = queries.find((q) => q.includes('FROM Contact')) ?? '';
      const limitMatches = soql.match(/\bLIMIT\b/gi) ?? [];
      expect(limitMatches.length, `variant: ${variant} got: ${soql}`).toBe(1);
      const limitNum = soql.match(/\bLIMIT\s+(\d+)/i);
      expect(limitNum, `variant: ${variant} got: ${soql}`).not.toBeNull();
      expect(parseInt(limitNum![1], 10)).toBeLessThanOrEqual(200);
      // No surviving comment fragments
      expect(soql).not.toMatch(/\/\//);
      expect(soql).not.toMatch(/\/\*/);

      await testClient.close();
      tempConfig.cleanup();
      vi.unstubAllEnvs();
    }
  });
});

describe('M3.2 — OAuth callback bind (VAL-SALESFORCE-017..019)', () => {
  let openServers: http.Server[] = [];

  afterEach(async () => {
    for (const srv of openServers) {
      try {
        srv.close();
      } catch {
        /* noop */
      }
    }
    openServers = [];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('VAL-SALESFORCE-017 — MCP_OAUTH_BIND_HOST is removed or restricted to loopback (static)', () => {
    const authSrc = fs.readFileSync(path.join(SRC_DIR, 'auth.ts'), 'utf-8');
    const matches = authSrc
      .split('\n')
      .map((line, idx) => ({ line, idx }))
      .filter((entry) => entry.line.includes('MCP_OAUTH_BIND_HOST'));
    if (matches.length === 0) return; // ok — env var fully removed
    const lines = authSrc.split('\n');
    for (const m of matches) {
      const start = Math.max(0, m.idx - 10);
      const end = Math.min(lines.length, m.idx + 10);
      const window = lines.slice(start, end).join('\n');
      const hasAllowList =
        /127\.0\.0\.1/.test(window) ||
        /::1/.test(window) ||
        /localhost/.test(window) ||
        /loopback/i.test(window);
      expect(
        hasAllowList,
        `MCP_OAUTH_BIND_HOST mention at line ${m.idx + 1} is not paired with a loopback allow-list`,
      ).toBe(true);
    }
  });

  async function runOAuthAndCaptureAddress(): Promise<http.AddressInfo | null> {
    let captured: http.AddressInfo | null = null;
    // Patch http.Server.prototype.listen — we cannot spy on the ESM
    // `http.createServer` named export, but the Server prototype is mutable.
    const origListen = http.Server.prototype.listen;
    function patchedListen(this: http.Server, ...args: unknown[]) {
      openServers.push(this);
      this.once('listening', () => {
        const addr = this.address();
        if (addr && typeof addr !== 'string') {
          captured = addr as http.AddressInfo;
        }
      });
      return (origListen as unknown as (...a: unknown[]) => http.Server).apply(
        this,
        args,
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (http.Server.prototype as any).listen = patchedListen;

    try {
      vi.resetModules();
      const { startStandaloneOAuth } = await import('../src/auth.js');

      // Suppress the URL print that happens on listen.
      const origConsoleError = console.error;
      console.error = () => {};

      const promise = startStandaloneOAuth();

      // Wait for the listening event.
      let waited = 0;
      while (captured === null && waited < 100) {
        await new Promise((r) => setTimeout(r, 10));
        waited++;
      }

      // Cancel the OAuth flow by emitting a synthetic error on the server.
      // The OAuth helper's `server.on('error', ...)` handler will resolve
      // the outer promise. This avoids needing to send a real HTTP request
      // (which would either go through MSW with onUnhandledRequest=error or
      // require complex passthrough wiring).
      for (const srv of openServers) {
        srv.emit('error', new Error('cancelled-by-test'));
      }

      await promise;
      console.error = origConsoleError;
    } finally {
      // Always restore the prototype regardless of test outcome.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (http.Server.prototype as any).listen = origListen;
    }
    return captured;
  }

  it('VAL-SALESFORCE-018 — OAuth server binds to 127.0.0.1', async () => {
    vi.stubEnv('SALESFORCE_CLIENT_ID', 'cid');
    vi.stubEnv('SALESFORCE_CLIENT_SECRET', 'csec');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    // Ensure we don't pick up any leaked env override.
    vi.stubEnv('MCP_OAUTH_BIND_HOST', '');
    vi.stubEnv('SALESFORCE_OAUTH_PORT', '0');

    const addr = await runOAuthAndCaptureAddress();
    expect(addr, 'no server.address() captured').not.toBeNull();
    expect((addr as http.AddressInfo).address).toBe('127.0.0.1');
    expect((addr as http.AddressInfo).family).toBe('IPv4');
  });

  it('VAL-SALESFORCE-019 — MCP_OAUTH_BIND_HOST=0.0.0.0 does NOT cause non-loopback bind', async () => {
    vi.stubEnv('SALESFORCE_CLIENT_ID', 'cid');
    vi.stubEnv('SALESFORCE_CLIENT_SECRET', 'csec');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MCP_OAUTH_BIND_HOST', '0.0.0.0');
    vi.stubEnv('SALESFORCE_OAUTH_PORT', '0');

    const addr = await runOAuthAndCaptureAddress();
    expect(addr, 'no server.address() captured').not.toBeNull();
    // Either we ignore the env var (preferred — bind 127.0.0.1) or we throw
    // a "loopback only" error. We never bind to 0.0.0.0.
    expect((addr as http.AddressInfo).address).not.toBe('0.0.0.0');
    expect((addr as http.AddressInfo).address).toBe('127.0.0.1');
  });
});

// ---------------------------------------------------------------------------
// M3-fix-A — quote-aware SOQL comment stripping (VAL-SALESFORCE-020..021)
// ---------------------------------------------------------------------------

describe('M3-fix-A — applyQueryLimitCap is quote-aware (VAL-SALESFORCE-020)', () => {
  it("VAL-SALESFORCE-020 — preserves '//' inside a single-quoted URL literal", async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = "SELECT Id FROM Lead WHERE Website = 'https://example.com/path'";
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe(
      "SELECT Id FROM Lead WHERE Website = 'https://example.com/path' LIMIT 200",
    );
  });

  it("VAL-SALESFORCE-020 — preserves '/* */' inside a single-quoted literal", async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = "SELECT Id FROM Lead WHERE Notes__c LIKE '/* keep */ test'";
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe(
      "SELECT Id FROM Lead WHERE Notes__c LIKE '/* keep */ test' LIMIT 200",
    );
  });

  it("VAL-SALESFORCE-020 — respects '' (doubled-apostrophe) escape and keeps '// ok' literal intact", async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = "SELECT Id FROM Lead WHERE Name = 'O''Brien // ok'";
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe(
      "SELECT Id FROM Lead WHERE Name = 'O''Brien // ok' LIMIT 200",
    );
  });

  it("VAL-SALESFORCE-020 — respects \\' (backslash-quote) escape inside a literal", async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = "SELECT Id FROM Lead WHERE Name = 'a\\'b // ok'";
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe(
      "SELECT Id FROM Lead WHERE Name = 'a\\'b // ok' LIMIT 200",
    );
  });

  it('VAL-SALESFORCE-020 — quoted literal with // is not corrupted into an unterminated literal', async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = "SELECT Id FROM Lead WHERE Website = 'https://example.com/path'";
    const output = applyQueryLimitCap(input, 200);
    // Quoted literal must remain balanced (count of single quotes is even).
    const quoteCount = (output.match(/'/g) ?? []).length;
    expect(quoteCount % 2).toBe(0);
    // The original quoted span is preserved verbatim.
    expect(output).toContain("'https://example.com/path'");
  });
});

describe('M3-fix-A — applyQueryLimitCap LIMIT-bypass guard preserved (VAL-SALESFORCE-021)', () => {
  it('VAL-SALESFORCE-021 — outside-quote // line comment after LIMIT still stripped', async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = 'SELECT Id FROM Lead LIMIT 5000 // bypass';
    const output = applyQueryLimitCap(input, 200);
    expect(output).not.toMatch(/\/\//);
    expect(output).not.toMatch(/bypass/);
    const limitMatches = output.match(/\bLIMIT\b/gi) ?? [];
    expect(limitMatches.length).toBe(1);
    const limitNum = output.match(/\bLIMIT\s+(\d+)/i);
    expect(limitNum).not.toBeNull();
    expect(parseInt(limitNum![1], 10)).toBeLessThanOrEqual(200);
  });

  it('VAL-SALESFORCE-021 — outside-quote /* */ block comment after LIMIT still stripped', async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = 'SELECT Id FROM Lead LIMIT 5000 /* bypass */';
    const output = applyQueryLimitCap(input, 200);
    expect(output).not.toMatch(/\/\*/);
    expect(output).not.toMatch(/bypass/);
    const limitMatches = output.match(/\bLIMIT\b/gi) ?? [];
    expect(limitMatches.length).toBe(1);
    const limitNum = output.match(/\bLIMIT\s+(\d+)/i);
    expect(limitNum).not.toBeNull();
    expect(parseInt(limitNum![1], 10)).toBeLessThanOrEqual(200);
  });

  it('VAL-SALESFORCE-021 — LIMIT 5000 OFFSET 100 → LIMIT capped, OFFSET preserved', async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = 'SELECT Id FROM Lead LIMIT 5000 OFFSET 100';
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe('SELECT Id FROM Lead LIMIT 200 OFFSET 100');
  });

  it('VAL-SALESFORCE-021 — OFFSET-only input has LIMIT appended and OFFSET preserved', async () => {
    const { applyQueryLimitCap } = await import('../src/tools/query.js');
    const input = 'SELECT Id FROM Lead OFFSET 50';
    const output = applyQueryLimitCap(input, 200);
    expect(output).toBe('SELECT Id FROM Lead LIMIT 200 OFFSET 50');
  });
});

describe('M3-fix-A — captured SOQL preserves quoted literals end-to-end (VAL-SALESFORCE-020)', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('VAL-SALESFORCE-020 — captured SOQL preserves // inside quoted Website value', async () => {
    const { queries } = captureSoqlQueries();
    tempConfig = createConfigWithToken();
    testClient = await createTestClient({ env: createAuthEnv(tempConfig.configPath) });

    const input = "SELECT Id, Name FROM Lead WHERE Website = 'https://example.com/path'";
    const result = await testClient.callTool('salesforce_query', { query: input });
    expect(result.json).toHaveProperty('ok', true);
    const soql = queries.find((q) => q.includes('FROM Lead')) ?? '';
    expect(soql, `expected one SOQL query against Lead, got: ${queries.join(' | ')}`).not.toBe('');
    // Quoted literal preserved verbatim, so the URL with `//` is intact.
    expect(soql).toContain("'https://example.com/path'");
    // LIMIT cap applied because input had no LIMIT.
    expect(soql).toMatch(/\bLIMIT\s+200\b/);
  });
});
