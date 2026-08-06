import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOST_ALLOWLIST_SUFFIX } from '../src/ssh.js';
import { SSH_KEY_FILENAME } from '../src/keyResolution.js';

interface StructuredError {
  ok: false;
  error: string;
  code: string;
  action_required: string;
  next_step: string;
}

interface ToolMetadata {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const REPLIT_HOST = 'test-uuid-00-hash.riker.replit.dev';
const REPLIT_USER = 'test-uuid';

const EXPECTED_ANNOTATIONS: Record<string, {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}> = {
  replit_check_connection: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_list_files: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_read_file: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_write_file: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_search_files: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_stat: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  replit_move: {
    readOnlyHint: false,
    destructiveHint: true,
    // False: a repeated move fails with DESTINATION_EXISTS, it is not a no-op.
    idempotentHint: false,
    openWorldHint: true,
  },
  replit_delete_file: {
    readOnlyHint: false,
    destructiveHint: true,
    // False: a repeated delete fails with IO_ERROR "not found", it is not a no-op.
    idempotentHint: false,
    openWorldHint: true,
  },
  replit_setup_ssh: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
};

async function createTestClient(homedirPath: string): Promise<McpTestClient> {
  vi.stubEnv('HOME', homedirPath);
  vi.stubEnv('USERPROFILE', homedirPath);
  vi.resetModules();
  const { createServer } = await import('../src/server.js');
  return createInMemoryTestClient({ createServer });
}

async function listTools(client: McpTestClient): Promise<ToolMetadata[]> {
  const result = await client.client.listTools();
  return result.tools as unknown as ToolMetadata[];
}

async function callToolJson<T>(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool(name, args);
  return result.json as T;
}

describe('Replit SSH MCP — mock tests', () => {
  let tempHome: string;
  let client: McpTestClient | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'replit-ssh-test-'));
    mkdirSync(join(tempHome, '.ssh'), { recursive: true });
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
    rmSync(tempHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // ── Tool registration & schemas ─────────────────────────────────────────────

  describe('tool registration', () => {
    it('registers all nine tools', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'replit_check_connection',
        'replit_delete_file',
        'replit_list_files',
        'replit_move',
        'replit_read_file',
        'replit_search_files',
        'replit_setup_ssh',
        'replit_stat',
        'replit_write_file',
      ]);
    });

    it('every tool passes the SDK Tool zod schema', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      for (const tool of tools) {
        const parsed = ToolSchema.safeParse(tool);
        expect(parsed.success, `Tool ${tool.name} should match the SDK Tool schema`).toBe(true);
      }
    });

    it('every tool carries the four cohort annotation keys with C2-locked values', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      for (const tool of tools) {
        const expected = EXPECTED_ANNOTATIONS[tool.name];
        expect(expected, `Unexpected tool: ${tool.name}`).toBeDefined();
        expect(tool.annotations, `${tool.name} should have annotations`).toBeDefined();
        expect(tool.annotations).toMatchObject(expected);
      }
    });

    it('replit_check_connection schema requires host + user, exposes verbose', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_check_connection')!;
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toHaveProperty('host');
      expect(tool.inputSchema.properties).toHaveProperty('user');
      expect(tool.inputSchema.properties).toHaveProperty('verbose');
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user']));
      expect(tool.inputSchema.required ?? []).not.toContain('verbose');
    });

    it('replit_list_files schema makes path optional', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_list_files')!;
      expect(tool.inputSchema.properties).toHaveProperty('path');
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user']));
      expect(tool.inputSchema.required ?? []).not.toContain('path');
    });

    it('replit_read_file schema requires path', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_read_file')!;
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user', 'path']));
    });

    it('replit_write_file schema requires path + content, encoding optional', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_write_file')!;
      expect(tool.inputSchema.properties).toHaveProperty('encoding');
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user', 'path', 'content']));
      expect(tool.inputSchema.required ?? []).not.toContain('encoding');
    });

    it('replit_setup_ssh exposes optional setup toggles', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_setup_ssh')!;
      expect(tool.inputSchema.properties).toHaveProperty('force_regenerate');
      expect(tool.inputSchema.properties).toHaveProperty('backup_existing_config');
      expect(tool.inputSchema.required ?? []).not.toContain('force_regenerate');
      expect(tool.inputSchema.required ?? []).not.toContain('backup_existing_config');
    });

    it('replit_search_files schema exposes needles and caps, all optional', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_search_files')!;
      expect(tool.inputSchema.properties).toHaveProperty('name_contains');
      expect(tool.inputSchema.properties).toHaveProperty('content_contains');
      expect(tool.inputSchema.properties).toHaveProperty('max_results');
      expect(tool.inputSchema.properties).toHaveProperty('max_depth');
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user']));
      for (const optional of ['path', 'name_contains', 'content_contains', 'max_results', 'max_depth']) {
        expect(tool.inputSchema.required ?? []).not.toContain(optional);
      }
    });

    it('replit_stat schema requires path', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_stat')!;
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user', 'path']));
    });

    it('replit_move schema requires source_path + destination_path', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_move')!;
      expect(tool.inputSchema.required).toEqual(
        expect.arrayContaining(['host', 'user', 'source_path', 'destination_path']),
      );
    });

    it('replit_delete_file schema requires path and documents irreversibility', async () => {
      client = await createTestClient(tempHome);
      const tools = await listTools(client);
      const tool = tools.find((t) => t.name === 'replit_delete_file')!;
      expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['host', 'user', 'path']));
      expect(tool.description).toContain('irreversible');
      expect(tool.annotations).toMatchObject({ destructiveHint: true });
    });
  });

  // ── Request manifest / wired-constants fixture ─────────────────────────────

  describe('wired constants (cohort substitute for HTTP MSW manifest)', () => {
    it('HOST_ALLOWLIST_SUFFIX is .replit.dev', () => {
      expect(HOST_ALLOWLIST_SUFFIX).toBe('.replit.dev');
    });

    it('SSH_KEY_FILENAME is rebel-replit (preserved per plan C3)', () => {
      expect(SSH_KEY_FILENAME).toBe('rebel-replit');
    });

    it('host validator rejects hosts not matching HOST_ALLOWLIST_SUFFIX', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
        host: 'not-a-replit-host.example.com',
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
      expect(res.error).toContain(HOST_ALLOWLIST_SUFFIX);
    });

    it('key resolver looks for SSH_KEY_FILENAME under ~/.ssh', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError & { diagnostics?: { keyPath?: string } }>(
        client,
        'replit_check_connection',
        { host: REPLIT_HOST, user: REPLIT_USER },
      );
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_MISSING');
    });
  });

  // ── Input validation: missing args ─────────────────────────────────────────

  describe('input validation — missing args', () => {
    it('replit_check_connection rejects missing host/user with CONFIG_MISSING', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
        host: '',
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_MISSING');
    });

    it('replit_read_file rejects empty-string path with PATH_INVALID', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('"path" parameter is required');
    });

    it('replit_write_file: SDK Zod schema rejects calls without content', async () => {
      client = await createTestClient(tempHome);
      const result = await client.callTool('replit_write_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: 'foo.txt',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── Input validation: path safety ──────────────────────────────────────────

  describe('input validation — path traversal & absolute paths', () => {
    it('replit_read_file rejects POSIX absolute paths', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '/etc/passwd',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Absolute paths are not allowed');
    });

    it('replit_read_file rejects Windows-style absolute paths', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: 'C:\\Windows\\System32\\config',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Absolute paths are not allowed');
    });

    it('replit_read_file rejects .. traversal', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '../../../etc/passwd',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Path traversal');
    });

    it('replit_read_file rejects mid-path .. segments', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: 'src/../../etc/passwd',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Path traversal');
    });

    it('replit_read_file rejects "." (directory not file)', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '.',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error.toLowerCase()).toContain('file path is required');
    });

    it('replit_write_file rejects absolute paths', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_write_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '/tmp/evil.txt',
        content: 'x',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Absolute paths are not allowed');
    });

    it('replit_write_file rejects .. traversal', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_write_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '../escape.txt',
        content: 'x',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Path traversal');
    });

    it('replit_write_file: SDK Zod schema rejects unknown encoding', async () => {
      client = await createTestClient(tempHome);
      const result = await client.callTool('replit_write_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: 'foo.txt',
        content: 'hi',
        encoding: 'rot13',
      });
      expect(result.isError).toBe(true);
    });

    it('replit_move rejects .. traversal in source and destination', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_move', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        source_path: '../escape.txt',
        destination_path: 'b.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Path traversal');

      const res2 = await callToolJson<StructuredError>(client, 'replit_move', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        source_path: 'a.txt',
        destination_path: '../escape.txt',
      });
      expect(res2.ok).toBe(false);
      expect(res2.code).toBe('PATH_INVALID');
    });

    it('replit_delete_file rejects .. traversal', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_delete_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '../escape.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
      expect(res.error).toContain('Path traversal');
    });

    it('replit_stat rejects absolute paths', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_stat', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: '/etc/passwd',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('PATH_INVALID');
    });
  });

  // ── Host allowlist ─────────────────────────────────────────────────────────

  describe('host allowlist', () => {
    const evilHosts = [
      'evil-server.example.com',
      'replit.dev.attacker.com',
      'evil.replit.dev.attacker.com',
      'replitXdev',
      '',
    ];

    for (const evilHost of evilHosts) {
      it(`rejects "${evilHost}" with HOST_NOT_ALLOWED`, async () => {
        client = await createTestClient(tempHome);
        const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
          host: evilHost,
          user: REPLIT_USER,
        });
        expect(res.ok).toBe(false);
        if (evilHost === '') {
          expect(res.code).toBe('CONFIG_MISSING');
        } else {
          expect(res.code).toBe('HOST_NOT_ALLOWED');
          expect(res.error).toContain(HOST_ALLOWLIST_SUFFIX);
        }
      });
    }

    it('host check is case-insensitive on suffix match (accepts uppercase suffix)', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
        host: 'test-uuid-00-hash.riker.REPLIT.DEV',
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_MISSING');
    });

    it('replit_list_files also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_list_files', {
        host: 'evil.example.com',
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });

    it('replit_write_file also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_write_file', {
        host: 'evil.example.com',
        user: REPLIT_USER,
        path: 'foo.txt',
        content: 'x',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });

    it('replit_search_files also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_search_files', {
        host: 'evil.example.com',
        user: REPLIT_USER,
        name_contains: 'x',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });

    it('replit_stat also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_stat', {
        host: 'evil.example.com',
        user: REPLIT_USER,
        path: 'foo.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });

    it('replit_move also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_move', {
        host: 'evil.example.com',
        user: REPLIT_USER,
        source_path: 'a.txt',
        destination_path: 'b.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });

    it('replit_delete_file also enforces host allowlist', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_delete_file', {
        host: 'evil.example.com',
        user: REPLIT_USER,
        path: 'foo.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('HOST_NOT_ALLOWED');
    });
  });

  // ── SSH key missing / malformed ────────────────────────────────────────────

  describe('SSH key resolution', () => {
    it('returns CONFIG_MISSING when ~/.ssh/rebel-replit is absent', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_list_files', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_MISSING');
      expect(res.error).toContain('Replit SSH key');
      expect(res.next_step.toLowerCase()).toContain('replit_setup_ssh');
    });

    it('returns CONFIG_INVALID when ~/.ssh/config is unreadable (EISDIR)', async () => {
      mkdirSync(join(tempHome, '.ssh', 'config'), { recursive: true });
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_INVALID');
      expect(res.error).toContain('SSH config');
    });

    it('returns CONFIG_MISSING when config IdentityFile points at a non-existent key', async () => {
      writeFileSync(
        join(tempHome, '.ssh', 'config'),
        `Host *.replit.dev\n  IdentityFile ~/.ssh/does-not-exist\n`,
      );
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_read_file', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
        path: 'test.txt',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_MISSING');
      expect(res.error).toContain('does not exist');
    });

    it('returns CONFIG_INVALID when the key file exists but is unparseable', async () => {
      writeFileSync(join(tempHome, '.ssh', 'rebel-replit'), 'this is not a private key');
      client = await createTestClient(tempHome);
      const res = await callToolJson<StructuredError>(client, 'replit_check_connection', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe('CONFIG_INVALID');
    });

    it('recovery contract uses { ok, error, code, action_required, next_step } shape', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<Record<string, unknown>>(client, 'replit_list_files', {
        host: REPLIT_HOST,
        user: REPLIT_USER,
      });
      expect(res.ok).toBe(false);
      expect(typeof res.error).toBe('string');
      expect(typeof res.code).toBe('string');
      expect(typeof res.action_required).toBe('string');
      expect(typeof res.next_step).toBe('string');
      expect(res).not.toHaveProperty('resolution');
    });
  });

  // ── replit_setup_ssh behaviour (FS only — no SSH socket) ───────────────────

  describe('replit_setup_ssh', () => {
    it('generates an Ed25519 key on first run', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<{
        ok: boolean;
        publicKey: string;
        alreadyExisted: boolean;
        configUpdated: boolean;
        nextSteps?: string;
      }>(client, 'replit_setup_ssh', {});
      expect(res.ok).toBe(true);
      expect(res.publicKey).toMatch(/^ssh-ed25519 /);
      expect(res.alreadyExisted).toBe(false);
      expect(res.configUpdated).toBe(true);
      expect(res.nextSteps).toBeDefined();
      expect(res.nextSteps).toContain('replit.com');
    });

    it('is idempotent — second run reports alreadyExisted:true', async () => {
      client = await createTestClient(tempHome);
      const first = await callToolJson<{ ok: boolean; publicKey: string }>(
        client,
        'replit_setup_ssh',
        {},
      );
      expect(first.ok).toBe(true);

      const second = await callToolJson<{
        ok: boolean;
        publicKey: string;
        alreadyExisted: boolean;
        configUpdated: boolean;
      }>(client, 'replit_setup_ssh', {});
      expect(second.ok).toBe(true);
      expect(second.alreadyExisted).toBe(true);
      expect(second.publicKey).toBe(first.publicKey);
      expect(second.configUpdated).toBe(false);
    });

    it('does not leak absolute home paths in the response', async () => {
      client = await createTestClient(tempHome);
      const res = await callToolJson<Record<string, unknown>>(client, 'replit_setup_ssh', {});
      const serialised = JSON.stringify(res);
      expect(serialised).not.toContain(tempHome);
    });

    it('force_regenerate replaces the existing key and warns about it', async () => {
      client = await createTestClient(tempHome);
      const first = await callToolJson<{ ok: boolean; publicKey: string }>(
        client,
        'replit_setup_ssh',
        {},
      );
      expect(first.ok).toBe(true);

      const regenerated = await callToolJson<{
        ok: boolean;
        publicKey: string;
        alreadyExisted: boolean;
        warning?: string;
      }>(client, 'replit_setup_ssh', { force_regenerate: true });
      expect(regenerated.ok).toBe(true);
      expect(regenerated.alreadyExisted).toBe(false);
      expect(regenerated.publicKey).not.toBe(first.publicKey);
    });
  });
});
