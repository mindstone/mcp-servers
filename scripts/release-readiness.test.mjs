#!/usr/bin/env node
// Run the workflow's actual shell with deterministic registry responses and time.
// Usage: node --test scripts/release-readiness.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

const sharedName = '@mindstone/shared-example';
const sharedPath = `node_modules/${sharedName}`;
const sharedIntegrity = 'sha512-current-example';

function runAsync(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, timeout: 20000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('bundle refuses cached npm success during a registry outage and removes its probe cache', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'release-cache-'));
  const probeRoot = join(directory, 'probes');
  mkdirSync(probeRoot);
  const env = { ...process.env, npm_config_cache: join(directory, 'user-cache'),
    npm_config_userconfig: join(directory, 'user.npmrc'), npm_config_globalconfig: join(directory, 'global.npmrc'),
    npm_config_fetch_retries: '0', npm_config_fetch_timeout: '1000', NODE_DISABLE_COMPILE_CACHE: '1', TMPDIR: probeRoot };
  writeFileSync(env.npm_config_userconfig, '');
  writeFileSync(env.npm_config_globalconfig, '');
  let broken = false;
  let current = '0.1.0';
  let requests = 0;
  const artifacts = {};
  const server = createServer((request, response) => {
    requests++;
    if (broken) return request.socket.destroy();
    if (request.url.endsWith('.tgz')) return response.end(artifacts[request.url.split('/').at(-1)].bytes);
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.end(JSON.stringify({ name: sharedName, 'dist-tags': { latest: current },
      versions: Object.fromEntries(Object.values(artifacts).filter(a => a.version <= current).map(a => [a.version, {
        name: sharedName, version: a.version,
        dist: { integrity: a.integrity, shasum: a.shasum, tarball: `${env.npm_config_registry}${a.filename}` },
      }])),
    }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    env.npm_config_registry = `http://127.0.0.1:${server.address().port}/`;
    for (const version of ['0.1.0', '0.1.1']) {
      const source = join(directory, version);
      mkdirSync(source);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: sharedName, version }));
      const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: source, env, encoding: 'utf8', timeout: 20000 });
      assert.ifError(packed.error);
      assert.equal(packed.status, 0, packed.stderr);
      const artifact = JSON.parse(packed.stdout)[0];
      artifacts[artifact.filename] = { ...artifact, bytes: readFileSync(join(source, artifact.filename)) };
    }
    const packageDir = join(directory, 'consumer');
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(identity));
    const packages = sharedPackages();
    packages[sharedPath].integrity = Object.values(artifacts)[0].integrity;
    writeFileSync(join(packageDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    const query = ['pack', `${sharedName}@^0.1.0`, '--dry-run', '--json', '--ignore-scripts', '--prefer-online'];
    const warm = await runAsync('npm', query, { cwd: packageDir, env });
    assert.equal(warm.status, 0, warm.stderr);
    assert.equal(JSON.parse(warm.stdout)[0].version, '0.1.0');
    current = '0.1.1';
    broken = true;
    requests = 0;
    const cached = await runAsync('npm', query, { cwd: packageDir, env });
    assert.equal(cached.status, 0, cached.stderr);
    assert.equal(JSON.parse(cached.stdout)[0].version, '0.1.0', 'real npm falls back to the warm answer');
    assert.ok(requests > 0, 'npm attempted revalidation');
    const result = await runAsync(process.execPath, [new URL('./check-bundled-shared.mjs', import.meta.url).pathname, packageDir], { env });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /could not ask npm/);
    assert.deepEqual(readdirSync(probeRoot), [], 'probe cache must be removed after failure');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bundle refuses a current version label with an older artifact integrity', () => {
  const packages = sharedPackages('0.1.1');
  packages[sharedPath].integrity = 'sha512-older-example';
  const result = runBundle({ packages });
  assertNotBundled(result);
  assert.match(result.stderr, /lockfile would pack a different file/i);
  assert.match(result.stderr, /npm update @mindstone\/shared-example --package-lock-only --ignore-scripts/);
});

function runBundle({ packages, answer = JSON.stringify([{ name: sharedName, version: '0.1.1', integrity: sharedIntegrity }]), status = 0 }) {
  const directory = mkdtempSync(join(tmpdir(), 'release-bundle-'));
  try {
    const packageDir = join(directory, 'connectors', 'example');
    const scriptsDir = join(directory, 'scripts');
    mkdirSync(join(packageDir, 'node_modules'), { recursive: true });
    mkdirSync(scriptsDir);
    const checker = new URL('./check-bundled-shared.mjs', import.meta.url);
    if (existsSync(checker)) copyFileSync(checker, join(scriptsDir, 'check-bundled-shared.mjs'));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ ...identity, dependencies: packages[''].dependencies }));
    writeFileSync(join(packageDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    for (const [location, entry] of Object.entries(packages)) {
      if (!location || !location.startsWith('node_modules/') || entry.link) continue;
      mkdirSync(join(packageDir, location), { recursive: true });
      writeFileSync(join(packageDir, location, 'package.json'), JSON.stringify(entry));
    }
    const logPath = join(directory, 'calls.jsonl');
    writeFileSync(logPath, '');
    writeFileSync(join(directory, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pack') {
  const cache = args[args.indexOf('--cache') + 1];
  if (!args.includes('--cache') || fs.readdirSync(cache).length !== 0) throw new Error('Expected a new empty probe cache');
  fs.writeFileSync(require('node:path').join(cache, 'probe-marker'), '');
  process.stdout.write(process.env.TEST_ANSWER);
  process.exit(Number(process.env.TEST_STATUS));
}
`, { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepShell('Bundle the tested dependency tree')], {
      cwd: packageDir,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, TEST_LOG: logPath,
        TEST_ANSWER: answer, TEST_STATUS: String(status) },
      encoding: 'utf8', timeout: 20000,
    });
    assert.ifError(result.error);
    const calls = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const args of calls.filter(args => args[0] === 'pack')) {
      assert.equal(existsSync(args[args.indexOf('--cache') + 1]), false, 'probe cache must be removed on success and failure');
    }
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function sharedPackages(version = '0.1.0') {
  return { '': { dependencies: { [sharedName]: '^0.1.0' } }, [sharedPath]: { version, integrity: sharedIntegrity } };
}

function assertNotBundled(result) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.calls.some(args => args[0] === 'pkg'), false);
}

test('bundle refuses a stale first-party lock and names both versions before setting bundleDependencies', () => {
  const result = runBundle({ packages: sharedPackages() });
  assertNotBundled(result);
  assert.match(result.stderr, /@mindstone\/shared-example.*0\.1\.0.*0\.1\.1/);
  assert.match(result.stderr, /npm update @mindstone\/shared-example --package-lock-only --ignore-scripts/);
});

for (const [label, response] of Object.entries({
  unreadable: { status: 1, answer: 'private registry diagnostic' },
  malformed: { answer: 'not json' },
  missing: { answer: '[]' },
  'missing version': { answer: JSON.stringify([{ name: sharedName }]) },
  'missing integrity': { answer: JSON.stringify([{ name: sharedName, version: '0.1.1' }]) },
  'empty integrity': { answer: JSON.stringify([{ name: sharedName, version: '0.1.1', integrity: ' ' }]) },
})) {
  test(`bundle refuses a ${label} registry answer without exposing npm output`, () => {
    const result = runBundle({ packages: sharedPackages(), ...response });
    assertNotBundled(result);
    assert.match(result.stderr, /@mindstone\/shared-example.*nothing was published.*retry/i);
    assert.equal(result.stderr.includes(response.answer), false);
  });
}

test('bundle accepts the current first-party lock and queries npm with the declared range', () => {
  const result = runBundle({ packages: sharedPackages('0.1.1') });
  assert.equal(result.status, 0, result.stderr);
  const request = result.calls.find(args => args[0] === 'pack');
  assert.deepEqual(request, [
    'pack', `${sharedName}@^0.1.0`, '--dry-run', '--json', '--ignore-scripts', '--prefer-online',
    '--cache', request.at(-1),
  ]);
  assert.ok(result.calls.some(args => args[0] === 'pkg' && args.includes('bundleDependencies=true')));
});

test('bundle refuses a lock with missing integrity', () => {
  const packages = sharedPackages('0.1.1');
  delete packages[sharedPath].integrity;
  const result = runBundle({ packages });
  assertNotBundled(result);
  assert.match(result.stderr, /lockfile would pack a different file/i);
});

test('bundle with no first-party production dependency needs no registry request', () => {
  const result = runBundle({ packages: { '': { dependencies: { example: '^1.0.0' } }, 'node_modules/example': { version: '1.0.0' } } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(args => args[0] === 'pack'), false);
  assert.ok(result.calls.some(args => args[0] === 'pkg'));
});

test('bundle ignores a development-only first-party file link', () => {
  const result = runBundle({ packages: {
    '': { devDependencies: { [sharedName]: 'file:../../packages/shared-example' } },
    [sharedPath]: { resolved: '../../packages/shared-example', link: true, dev: true },
    '../../packages/shared-example': { name: sharedName, version: '0.1.0', dev: true },
  } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(args => args[0] === 'pack'), false);
  assert.ok(result.calls.some(args => args[0] === 'pkg'));
});

test('bundle checks a nested first-party copy using its dependent package range', () => {
  const result = runBundle({ packages: {
    '': { dependencies: { example: '^1.0.0' } },
    'node_modules/example': { version: '1.0.0', dependencies: { [sharedName]: '~0.1.0' } },
    [`node_modules/example/${sharedPath}`]: { version: '0.1.0' },
  } });
  assertNotBundled(result);
  assert.match(result.stderr, /@mindstone\/shared-example.*0\.1\.0.*0\.1\.1/);
  assert.equal(result.calls.find(args => args[0] === 'pack')?.[1], `${sharedName}@~0.1.0`);
});
