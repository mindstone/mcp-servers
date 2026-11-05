#!/usr/bin/env node
// Run the workflow's actual shell with deterministic registry responses and time.
// Usage: node --test scripts/release-readiness.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const waitName = 'Wait for npm to serve the new version';
const publishName = 'Publish to MCP registry (github-oidc)';
const identity = { name: '@example/mcp-server-demo', version: '1.2.3' };
const tarball = 'https://registry.npmjs.org/@example/mcp-server-demo/-/mcp-server-demo-1.2.3.tgz';
const metadata = { ...identity, dist: { tarball, shasum: 'abc123', integrity: 'sha512-example' } };

function stepShell(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + 1);
  const section = workflow.slice(start, end === -1 ? undefined : end);
  const body = section.split('        run: |\n')[1];
  assert.ok(body, `Missing shell: ${name}`);
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}

const fakeCommand = `#!/usr/bin/env node
const fs = require('node:fs');
const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE, 'utf8'));
function save() { fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state)); }
function log(extra = {}) {
  fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ command, args, at: state.now, ...extra }) + '\\n');
}
if (command === 'awk') {
  console.log(state.now);
} else if (command === 'sleep') {
  log(); state.now += Number(args[0]); save();
} else if (command === 'timeout') {
  log();
  const durationIndex = args[0] === '-s' ? 2 : 0;
  const budget = Number(args[durationIndex].replace(/s$/, ''));
  const result = spawnSync(args[durationIndex + 1], args.slice(durationIndex + 2), {
    env: { ...process.env, TEST_REQUEST_LIMIT: String(budget) }, stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
} else if (command === 'npm' || command === 'curl') {
  const calls = state[command + 'Calls']++;
  const responses = state[command];
  const response = responses[Math.min(calls, responses.length - 1)];
  const budget = command === 'npm' ? Number(process.env.TEST_REQUEST_LIMIT || Infinity)
    : Number(args[args.indexOf('--max-time') + 1] || Infinity);
  log({ budget: Number.isFinite(budget) ? budget : null });
  state.now += Math.min(response.seconds || 0, budget);
  save();
  if ((response.seconds || 0) >= budget) process.exit(124);
  if (command === 'npm' && !response.status) {
    console.log(args.includes('--json') ? JSON.stringify(response.metadata) : response.metadata.version);
  }
  if (command === 'curl' && !response.status && args.includes('--write-out')) {
    console.log(response.httpStatus || '200');
  }
  process.exit(response.status || 0);
} else {
  log(); process.exit(99); // A missing manifest must never reach the publisher.
}
`;

function run({ npm = [{ metadata }], curl = [{}], manifest = true, shell = stepShell(waitName) } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-readiness-'));
  try {
    const statePath = join(directory, 'state.json');
    const logPath = join(directory, 'calls.jsonl');
    writeFileSync(statePath, JSON.stringify({ now: 1000, npmCalls: 0, curlCalls: 0, npm, curl }));
    writeFileSync(logPath, '');
    writeFileSync(join(directory, 'package.json'), JSON.stringify(identity));
    if (manifest) writeFileSync(join(directory, 'server.json'), '{}');
    const fakePath = join(directory, 'fake.cjs');
    writeFileSync(fakePath, fakeCommand, { mode: 0o755 });
    for (const command of ['npm', 'curl', 'awk', 'sleep', 'timeout', 'mcp-publisher']) {
      symlinkSync(fakePath, join(directory, command));
    }
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', shell], {
      cwd: directory,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, TEST_STATE: statePath, TEST_LOG: logPath },
      encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    return {
      ...result,
      state: JSON.parse(readFileSync(statePath, 'utf8')),
      calls: readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('metadata readiness alone must not bypass delayed tarball GETs', () => {
  const result = run({ curl: [{ status: 22 }, { status: 22 }, {}] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.curlCalls, 3, 'must retry the download even when metadata is already served');
  assert.equal(result.state.now, 1020);
});

test('metadata lag and wrong identity cannot reach a download', () => {
  const result = run({ npm: [
    { status: 1 },
    { metadata: { ...metadata, version: '1.2.2' } },
    { metadata: { ...metadata, name: '@example/other' } },
    { metadata: { ...identity, dist: {} } },
    { metadata },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.npmCalls, 5);
  assert.equal(result.state.curlCalls, 1);
  assert.equal(result.state.now, 1040);
});

test('exact metadata identity and a successful body GET finish immediately', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.npmCalls, 1);
  assert.equal(result.state.curlCalls, 1);
  assert.equal(result.state.now, 1000);
  const request = result.calls.find(call => call.command === 'curl');
  assert.ok(request.args.includes(tarball));
  assert.ok(request.args.includes('--fail'));
  assert.equal(request.args[request.args.indexOf('--output') + 1], '/dev/null');
  assert.equal(request.args.includes('--head') || request.args.includes('-I'), false);
  assert.equal(request.args.includes('--location') || request.args.includes('-L'), false);
  assert.match(result.stdout, /tarball/);
});

test('redirects and empty responses do not count as a successful tarball GET', () => {
  const result = run({ curl: [{ httpStatus: '302' }, { httpStatus: '204' }, {}] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.state.curlCalls, 3);
  assert.equal(result.state.now, 1020);
});

test('unavailable tarball fails after ten minutes, including requests and sleeps', () => {
  const result = run({ curl: [{ status: 22, seconds: 25 }] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.state.now, 1600);
  assert.match(result.stdout, /::error::.*@example\/mcp-server-demo@1\.2\.3.*10 minutes/);
  assert.match(result.stdout, /Re-run/);
});

for (const command of ['npm', 'curl']) {
  test(command + ' requests are capped by the remaining deadline', () => {
    const options = command === 'npm' ? { npm: [{ status: 1, seconds: 1 }, { metadata, seconds: 1000 }] }
      : { curl: [{ status: 22, seconds: 1 }, { seconds: 1000 }] };
    const result = run(options);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.state.now, 1600);
    const requests = result.calls.filter(call => call.command === command);
    assert.ok(requests.length > 1);
    for (const request of requests) {
      assert.ok(request.budget > 0 && request.budget <= Math.min(30, 1600 - request.at), JSON.stringify(request));
      if (command === 'npm') {
        assert.ok(request.args.includes('--fetch-retries=0'));
        assert.ok(request.args.includes('--fetch-timeout=' + request.budget * 1000));
      }
    }
    assert.ok(requests.at(-1).budget < 30, 'last request uses only the remaining budget');
    for (const sleep of result.calls.filter(call => call.command === 'sleep')) {
      assert.ok(Number(sleep.args[0]) <= Math.min(10, 1600 - sleep.at));
    }
  });
}

test('tarball timeout uses the budget remaining after the metadata request', () => {
  const result = run({
    npm: [...Array.from({ length: 14 }, () => ({ status: 1, seconds: 30 })), { metadata, seconds: 25 }],
    curl: [{ seconds: 1000 }],
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.state.now, 1600);
  const request = result.calls.find(call => call.command === 'curl');
  assert.ok(request, 'must attempt a GET after the exact metadata arrives');
  assert.equal(request.at, 1585);
  assert.equal(request.budget, 15);
});

test('missing server.json skips both readiness probes and publisher login/publication', () => {
  for (const name of [waitName, publishName]) {
    const result = run({ manifest: false, shell: stepShell(name) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, []);
    assert.match(result.stdout, /Skipping/);
  }
});

test('gate precedes login/publication with bounded job and installer headroom', () => {
  assert.ok(workflow.indexOf(`- name: ${waitName}`) < workflow.indexOf(`- name: ${publishName}`));
  const registryJob = workflow.slice(workflow.indexOf('\n  publish-mcp-registry:'));
  assert.match(registryJob, /timeout-minutes: 15/);
  assert.match(registryJob, /- name: Install mcp-publisher \(pinned \+ checksum\)\n        timeout-minutes: 2/);
  assert.match(stepShell(publishName), /mcp-publisher login github-oidc\n.*mcp-publisher publish/);
  assert.doesNotMatch(stepShell(waitName), /mcp-publisher/);
});

test('production wait shell parses in bash', () => {
  const result = spawnSync('bash', ['-n'], { input: stepShell(waitName), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
