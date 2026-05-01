import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { createTempConfig, type TempConfigResult } from '@mindstone-engineering/mcp-test-harness';

const SRC_DIR = path.resolve(import.meta.dirname, '../src');
const TEST_DIR = path.resolve(import.meta.dirname, '.');

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

describe('Security audit — Outreach MCP server', () => {
  it('contains no internal mindstone/rebel/nspr references in source (except bridge.ts legacy env var)', () => {
    const srcFiles = getAllFiles(SRC_DIR);
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const basename = path.basename(file);

      // bridge.ts is allowed to have MINDSTONE_REBEL_BRIDGE_STATE as legacy fallback
      if (basename === 'bridge.ts') {
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.includes('MINDSTONE_REBEL_BRIDGE_STATE')) continue; // allowed legacy fallback
          expect(line.toLowerCase(), `Unexpected reference in bridge.ts: ${line.trim()}`).not.toMatch(/mindstone|rebel|nspr/);
        }
        continue;
      }

      expect(content.toLowerCase(), `Unexpected reference in ${basename}`).not.toMatch(/mindstone|rebel|nspr/);
    }
  });

  it('contains no hardcoded secrets', () => {
    const allContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    expect(allContent).not.toMatch(/sk_live|sk_test|key_real|xoxb-|xoxp-/);
  });

  it('contains no host-specific bridge endpoints', () => {
    const srcContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    expect(srcContent).not.toMatch(/\/bundled\//);
  });

  it('error messages are host-neutral (no Rebel/Mindstone in user-facing strings)', () => {
    const srcContent = getAllFiles(SRC_DIR)
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');

    const lines = srcContent.split('\n');
    for (const line of lines) {
      // Skip comments, imports, and the legacy bridge env var constant
      if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('import')) continue;
      if (line.includes('MINDSTONE_REBEL_BRIDGE_STATE')) continue;

      // Check string literals for host-specific references
      const stringMatches = line.match(/'[^']*'|"[^"]*"|`[^`]*`/g);
      if (stringMatches) {
        for (const str of stringMatches) {
          expect(str.toLowerCase()).not.toMatch(/\brebel\b/);
          expect(str.toLowerCase()).not.toMatch(/\bmindstone\b/);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// M3.3 — OAuth callback bind hardening + outreach_add_prospect_to_sequence
//        destructiveHint flip (VAL-OUTREACH-001..007)
// ---------------------------------------------------------------------------

describe('M3.3 — outreach_add_prospect_to_sequence destructiveHint (VAL-OUTREACH-005..007)', () => {
  let testClient: McpTestClient;
  let tempConfig: TempConfigResult;

  afterEach(async () => {
    if (testClient) await testClient.close();
    if (tempConfig) tempConfig.cleanup();
    vi.unstubAllEnvs();
  });

  it('VAL-OUTREACH-005 — sequences.ts annotation block contains destructiveHint: true (static)', () => {
    const sequencesSrc = fs.readFileSync(path.join(SRC_DIR, 'tools', 'sequences.ts'), 'utf-8');
    const idx = sequencesSrc.indexOf("'outreach_add_prospect_to_sequence'");
    expect(idx, 'expected to find outreach_add_prospect_to_sequence registration').toBeGreaterThan(-1);
    // Slice from the registration start to the first subsequent withErrorHandling boundary (end of registerTool args).
    const tail = sequencesSrc.slice(idx);
    const blockEnd = tail.indexOf('withErrorHandling(');
    expect(blockEnd).toBeGreaterThan(-1);
    const block = tail.slice(0, blockEnd);
    expect(block).toMatch(/destructiveHint:\s*true/);
    expect(block).not.toMatch(/destructiveHint:\s*false/);
  });

  it('VAL-OUTREACH-006 — tools/list reports destructiveHint === true', async () => {
    tempConfig = createTempConfig({ empty: true });
    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.client.listTools();
    const tool = result.tools.find((t) => t.name === 'outreach_add_prospect_to_sequence');
    expect(tool, 'expected outreach_add_prospect_to_sequence in tools/list').toBeDefined();
    expect(tool!.annotations).toBeDefined();
    expect((tool!.annotations as Record<string, unknown>).destructiveHint).toBe(true);
  });

  it('VAL-OUTREACH-007 — annotation strictly true (not false, not omitted)', async () => {
    tempConfig = createTempConfig({ empty: true });
    testClient = await createTestClient({
      env: {
        OUTREACH_CLIENT_ID: 'test-client-id',
        OUTREACH_CLIENT_SECRET: 'test-client-secret',
        OUTREACH_CONFIG_DIR: tempConfig.configPath,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });

    const result = await testClient.client.listTools();
    const tool = result.tools.find((t) => t.name === 'outreach_add_prospect_to_sequence');
    expect(tool).toBeDefined();
    const annotations = (tool!.annotations ?? {}) as Record<string, unknown>;
    expect(annotations.destructiveHint).not.toBe(false);
    expect(annotations.destructiveHint).toBe(true);
  });
});

describe('M3.3 — OAuth callback bind hardening (VAL-OUTREACH-001..004)', () => {
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

  it('VAL-OUTREACH-001 — MCP_OAUTH_BIND_HOST removed or restricted to loopback (static)', () => {
    const authSrc = fs.readFileSync(path.join(SRC_DIR, 'auth.ts'), 'utf-8');
    const lines = authSrc.split('\n');
    const matches = lines
      .map((line, idx) => ({ line, idx }))
      .filter((entry) => entry.line.includes('MCP_OAUTH_BIND_HOST'));
    if (matches.length === 0) return; // ok — env var fully removed
    for (const m of matches) {
      const start = Math.max(0, m.idx - 10);
      const end = Math.min(lines.length, m.idx + 10);
      const window = lines.slice(start, end).join('\n');
      const hasLoopbackAllowList =
        /127\.0\.0\.1/.test(window) ||
        /::1/.test(window) ||
        /localhost/.test(window) ||
        /loopback/i.test(window);
      expect(
        hasLoopbackAllowList,
        `MCP_OAUTH_BIND_HOST mention at line ${m.idx + 1} is not paired with a loopback allow-list`,
      ).toBe(true);
    }
  });

  it('VAL-OUTREACH-002 — no non-loopback string literal passed to server.listen', () => {
    const authSrc = fs.readFileSync(path.join(SRC_DIR, 'auth.ts'), 'utf-8');
    expect(authSrc).not.toMatch(/server\.listen\([^)]*['"]0\.0\.0\.0['"]/);
    expect(authSrc).not.toMatch(/server\.listen\([^)]*['"]::['"]/);
  });

  async function runOAuthAndCaptureAddress(): Promise<http.AddressInfo | null> {
    let captured: http.AddressInfo | null = null;
    const origListen = http.Server.prototype.listen;
    function patchedListen(this: http.Server, ...args: unknown[]) {
      openServers.push(this);
      this.once('listening', () => {
        const addr = this.address();
        if (addr && typeof addr !== 'string') {
          captured = addr as http.AddressInfo;
        }
      });
      return (origListen as unknown as (...a: unknown[]) => http.Server).apply(this, args);
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
      // The OAuth helper's `server.on('error', ...)` handler resolves the
      // outer promise. Avoids needing a real HTTP request.
      for (const srv of openServers) {
        srv.emit('error', new Error('cancelled-by-test'));
      }

      await promise;
      console.error = origConsoleError;
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (http.Server.prototype as any).listen = origListen;
    }
    return captured;
  }

  it('VAL-OUTREACH-003 — OAuth server binds to 127.0.0.1', async () => {
    vi.stubEnv('OUTREACH_CLIENT_ID', 'cid');
    vi.stubEnv('OUTREACH_CLIENT_SECRET', 'csec');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MCP_OAUTH_BIND_HOST', '');
    vi.stubEnv('OUTREACH_OAUTH_PORT', '0');

    const addr = await runOAuthAndCaptureAddress();
    expect(addr, 'no server.address() captured').not.toBeNull();
    expect((addr as http.AddressInfo).address).toBe('127.0.0.1');
    expect((addr as http.AddressInfo).family).toBe('IPv4');
  });

  it('VAL-OUTREACH-004 — MCP_OAUTH_BIND_HOST=0.0.0.0 does NOT cause non-loopback bind', async () => {
    vi.stubEnv('OUTREACH_CLIENT_ID', 'cid');
    vi.stubEnv('OUTREACH_CLIENT_SECRET', 'csec');
    vi.stubEnv('MCP_HOST_BRIDGE_STATE', '');
    vi.stubEnv('MCP_OAUTH_BIND_HOST', '0.0.0.0');
    vi.stubEnv('OUTREACH_OAUTH_PORT', '0');

    const addr = await runOAuthAndCaptureAddress();
    expect(addr, 'no server.address() captured').not.toBeNull();
    expect((addr as http.AddressInfo).address).not.toBe('0.0.0.0');
    expect((addr as http.AddressInfo).address).toBe('127.0.0.1');
  });
});
