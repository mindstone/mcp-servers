// Smoke test — verifies the built server can complete an MCP handshake and
// list its tools. Uses only Node.js built-ins (node:test, node:child_process)
// so the scaffold passes with no extra dev-dependencies.
//
// Preconditions:
//   - `npm run build` has been run (dist/index.js exists).
//   - The server exposes at least one tool.
//
// The handshake follows the MCP JSON-RPC 2.0 stdio transport — see
// https://modelcontextprotocol.io/specification for the protocol details.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const DIST = 'dist/index.js';
const HANDSHAKE_TIMEOUT_MS = 5000;

function readJsonLines(stream, { timeoutMs, predicate }) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms waiting for predicate match`)),
      timeoutMs,
    );
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (predicate(parsed)) {
          clearTimeout(timer);
          stream.removeListener('data', onData);
          resolve(parsed);
          return;
        }
      }
    };
    stream.on('data', onData);
    stream.once('close', () => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      reject(new Error('stream closed before predicate matched'));
    });
  });
}

function spawnServer() {
  if (!existsSync(DIST)) {
    throw new Error(`${DIST} not found — run \`npm run build\` before \`npm test\``);
  }
  return spawn(process.execPath, [DIST], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}

test('server completes MCP initialize handshake', async (t) => {
  const child = spawnServer();
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  const initReq = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.0' },
    },
  };
  child.stdin.write(JSON.stringify(initReq) + '\n');

  const response = await readJsonLines(child.stdout, {
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
    predicate: (m) => m.id === 1,
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result, 'initialize response must include result');
  assert.ok(
    typeof response.result.protocolVersion === 'string',
    'initialize response must include protocolVersion',
  );
});

test('tools/list returns at least one registered tool', async (t) => {
  const child = spawnServer();
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
  });

  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.0' },
    },
  };
  const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

  child.stdin.write(JSON.stringify(init) + '\n');
  child.stdin.write(JSON.stringify(initialized) + '\n');
  child.stdin.write(JSON.stringify(listReq) + '\n');

  const response = await readJsonLines(child.stdout, {
    timeoutMs: HANDSHAKE_TIMEOUT_MS,
    predicate: (m) => m.id === 2,
  });

  assert.ok(Array.isArray(response.result?.tools), 'tools/list must return a tools array');
  assert.ok(response.result.tools.length > 0, 'server must register at least one tool');
  for (const tool of response.result.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0, 'tool.name must be a non-empty string');
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, 'tool.description must be non-empty');
    assert.equal(tool.inputSchema?.type, 'object', 'every tool inputSchema.type must be "object"');
  }
});
