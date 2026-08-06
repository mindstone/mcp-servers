import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPLIT_HOST = process.env.OSS_TEST_BUNDLED_REPLIT_SSH__HOST;
const REPLIT_USER = process.env.OSS_TEST_BUNDLED_REPLIT_SSH__USER;
const ALLOW_SETUP_MUTATIONS = process.env.OSS_TEST_BUNDLED_REPLIT_SSH__ALLOW_SETUP_MUTATIONS === '1';

const HAVE_CREDS = Boolean(REPLIT_HOST && REPLIT_USER);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED_ANNOTATIONS: Record<string, {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}> = {
  replit_check_connection: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  replit_list_files: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  replit_read_file: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  replit_write_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  replit_search_files: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  replit_stat: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  replit_move: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  replit_delete_file: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  replit_setup_ssh: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function packTarball(packageRoot: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'replit-ssh-live-pack-'));
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn('npm', ['pack', '--pack-destination', tmpDir, '--silent'], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.on('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`npm pack failed with code ${code}`));
        return;
      }
      const tarballName = stdout.trim().split('\n').pop()!;
      resolvePromise(join(tmpDir, tarballName));
    });
  });
}

function extractTarball(tarball: string): Promise<string> {
  const extractDir = mkdtempSync(join(tmpdir(), 'replit-ssh-live-extract-'));
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const proc = spawn(
      'tar',
      ['-xzf', tarball, '-C', extractDir, '--strip-components=1'],
      { stdio: 'inherit' },
    );
    proc.on('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`tar -xzf failed with code ${code}`));
        return;
      }
      resolvePromise(extractDir);
    });
  });
}

function installProductionDeps(extractedDir: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', '--silent'],
      { cwd: extractedDir, stdio: 'inherit' },
    );
    proc.on('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`npm install in extracted tarball failed (code ${code})`));
        return;
      }
      resolvePromise();
    });
  });
}

describe.skipIf(!HAVE_CREDS)('Replit SSH MCP — live API probe (packed tarball)', () => {
  let client: Client | undefined;
  let extractedDir: string | undefined;
  let tarballDir: string | undefined;
  const seededPaths = new Set<string>();
  const latencies: { tool: string; ms: number }[] = [];

  async function measure<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      latencies.push({ tool, ms: performance.now() - start });
    }
  }

  function parseToolJson(result: ToolCallResult): Record<string, unknown> {
    const text = result.content.find((c) => c.type === 'text')?.text ?? '';
    return JSON.parse(text) as Record<string, unknown>;
  }

  beforeAll(async () => {
    const tarball = await packTarball(PACKAGE_ROOT);
    tarballDir = dirname(tarball);
    extractedDir = await extractTarball(tarball);
    await installProductionDeps(extractedDir);

    const binPath = join(extractedDir, 'dist', 'index.js');
    const transport = new StdioClientTransport({ command: 'node', args: [binPath] });
    client = new Client({ name: 'replit-ssh-live-probe', version: '0.0.0' });
    await client.connect(transport);
  }, 180_000);

  afterAll(async () => {
    if (client && HAVE_CREDS) {
      for (const seeded of seededPaths) {
        try {
          await measure('cleanup_overwrite', async () => {
            await client!.callTool({
              name: 'replit_write_file',
              arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: seeded, content: '' },
            });
          });
        } catch {
          // best-effort — no replit_delete_file tool; leaving empty file is acceptable.
        }
      }
    }
    try { await client?.close(); } catch { /* ignore */ }
    if (extractedDir) {
      try { rmSync(extractedDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (tarballDir) {
      try { rmSync(tarballDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    if (latencies.length > 0) {
      const sorted = [...latencies].sort((a, b) => a.ms - b.ms);
      const slowest = sorted[sorted.length - 1];
      const p95 = quantile(sorted.map((l) => l.ms), 0.95);
      const p50 = quantile(sorted.map((l) => l.ms), 0.5);
       
      console.log(`[live-probe] latency p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms slowest=${slowest.tool} ${slowest.ms.toFixed(0)}ms n=${sorted.length}`);
    }
  });

  it('lists 9 tools matching the C2-locked annotation set', async () => {
    const result = await client!.listTools();
    expect(result.tools).toHaveLength(9);
    for (const tool of result.tools) {
      const parsed = ToolSchema.safeParse(tool);
      expect(parsed.success, `Tool ${tool.name} must match the SDK Tool schema`).toBe(true);
      const expected = EXPECTED_ANNOTATIONS[tool.name];
      expect(expected, `Unexpected tool: ${tool.name}`).toBeDefined();
      expect(tool.annotations).toMatchObject(expected);
    }
  });

  it('replit_check_connection returns ok:true with workingDirectory + sftpSupported:true', async () => {
    const result = await measure('replit_check_connection', () =>
      client!.callTool({
        name: 'replit_check_connection',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER },
      }),
    ) as ToolCallResult;
    const parsed = parseToolJson(result);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.workingDirectory).toBe('string');
    expect((parsed.workingDirectory as string).length).toBeGreaterThan(0);
    expect(parsed.sftpSupported).toBe(true);
  }, 90_000);

  it('replit_list_files (path=".") returns a non-empty entries array', async () => {
    const result = await measure('replit_list_files', () =>
      client!.callTool({
        name: 'replit_list_files',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: '.' },
      }),
    ) as ToolCallResult;
    const parsed = parseToolJson(result);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.entries)).toBe(true);
    expect((parsed.entries as unknown[]).length).toBeGreaterThan(0);
  }, 90_000);

  it('replit_write_file + replit_read_file round-trip (utf-8) with SHA-256 verification', async () => {
    const testPath = `__rebel-mcp-test-${Date.now()}-utf8.txt`;
    const content = `live-probe-${Math.random().toString(36).slice(2)}`;

    const writeResult = await measure('replit_write_file', () =>
      client!.callTool({
        name: 'replit_write_file',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: testPath, content },
      }),
    ) as ToolCallResult;
    const writeParsed = parseToolJson(writeResult);
    expect(writeParsed.ok).toBe(true);
    expect(writeParsed.verified).toBe(true);
    seededPaths.add(testPath);

    const readResult = await measure('replit_read_file', () =>
      client!.callTool({
        name: 'replit_read_file',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: testPath },
      }),
    ) as ToolCallResult;
    const readParsed = parseToolJson(readResult);
    expect(readParsed.ok).toBe(true);
    expect(readParsed.encoding).toBe('utf-8');
    expect(readParsed.content).toBe(content);
  }, 120_000);

  it('replit_write_file + replit_read_file round-trip (base64) on a small PNG-shaped buffer', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const base64 = pngHeader.toString('base64');
    const testPath = `__rebel-mcp-test-${Date.now()}-binary.bin`;

    const writeResult = await measure('replit_write_file', () =>
      client!.callTool({
        name: 'replit_write_file',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: testPath, content: base64, encoding: 'base64' },
      }),
    ) as ToolCallResult;
    const writeParsed = parseToolJson(writeResult);
    expect(writeParsed.ok).toBe(true);
    expect(writeParsed.verified).toBe(true);
    seededPaths.add(testPath);

    const readResult = await measure('replit_read_file', () =>
      client!.callTool({
        name: 'replit_read_file',
        arguments: { host: REPLIT_HOST, user: REPLIT_USER, path: testPath },
      }),
    ) as ToolCallResult;
    const readParsed = parseToolJson(readResult);
    expect(readParsed.ok).toBe(true);
    expect(readParsed.encoding).toBe('base64');
    expect(readParsed.content).toBe(base64);
  }, 120_000);

  it.skipIf(!ALLOW_SETUP_MUTATIONS)(
    'replit_setup_ssh idempotency (opt-in: OSS_TEST_BUNDLED_REPLIT_SSH__ALLOW_SETUP_MUTATIONS=1)',
    async () => {
      const result = await measure('replit_setup_ssh', () =>
        client!.callTool({
          name: 'replit_setup_ssh',
          arguments: { force_regenerate: false },
        }),
      ) as ToolCallResult;
      const parsed = parseToolJson(result);
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.publicKey).toBe('string');
      if (parsed.alreadyExisted === true) {
        expect((parsed.publicKey as string).length).toBeGreaterThan(0);
      }
    },
    60_000,
  );
});
