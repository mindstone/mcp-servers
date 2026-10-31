// Live probe of the built connector against one real provider, through MCP as a host runs it.
// Usage: npm run build, set that provider's key (FLY_API_TOKEN, E2B_API_KEY or GOOGLE_CLOUD_KEY, plus
// any optional settings), then: node test/live-probe.mjs <fly|e2b|gcp> <results.json>
// It creates a computer, runs every tool, removes the computer, and writes pass or fail per step.
// It never prints a key. It costs a few minutes of the provider's billing.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [provider, out] = process.argv.slice(2);
if (!['fly', 'e2b', 'gcp'].includes(provider) || !out) {
  console.error('Usage: node test/live-probe.mjs <fly|e2b|gcp> <results.json>');
  process.exit(2);
}
const computer = `probe-${provider}`;
const library = mkdtempSync(join(tmpdir(), 'computers-probe-'));
writeFileSync(join(library, 'note.txt'), 'hello from the library\n');
const client = new Client({ name: 'live-probe', version: '0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, MCP_WORKSPACE_PATH: library, COMPUTERS_DEFAULT_PROVIDER: provider },
    stderr: 'ignore',
  }),
);
const steps = [];

async function call(name, args, opts = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000, ...opts });
  const text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  let body;
  try { body = JSON.parse(text); } catch { body = { text }; }
  return { result, body, images: result.content.filter((c) => c.type === 'image').length };
}
const output = (body) => (body.output ?? '').replace(/^<untrusted-content[^>]*>|<\/untrusted-content>$/g, '');

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    steps.push({ step: name, status: 'pass', seconds: +((Date.now() - t0) / 1000).toFixed(1), detail });
  } catch (error) {
    steps.push({ step: name, status: 'fail', seconds: +((Date.now() - t0) / 1000).toFixed(1), detail: String(error.message ?? error).slice(0, 300) });
  }
}
const expect = (ok, message) => { if (!ok) throw new Error(message); };

async function waitJob(job) {
  for (let i = 0; i < 20; i++) {
    const { body } = await call('computer_job', { computer, job });
    if (body.state !== 'running') return body;
  }
  throw new Error('job never finished');
}

await step('check setup', async () => {
  const { body } = await call('computer_check_setup', {});
  expect(body.accounts?.every((a) => a.ok), JSON.stringify(body));
  return body.accounts.map((a) => a.provider).join(',');
});
await step('create with setup', async () => {
  const { body, result } = await call('computer_create', { name: computer, provider });
  expect(!result.isError, JSON.stringify(body));
  const setup = body.setup.state === 'running' ? await waitJob(body.setup.job) : body.setup;
  expect(setup.state === 'finished' && setup.exit_code === 0, `setup ${setup.state} ${setup.exit_code}`);
  return 'browser installed';
});
await step('run a command', async () => {
  const { body } = await call('computer_run', { computer, command: 'echo hello-$(whoami)' });
  expect(body.exit_code === 0 && output(body).startsWith('hello-'), output(body));
  return output(body).trim();
});
await step('missing folder runs nothing', async () => {
  const { body } = await call('computer_run', { computer, command: 'touch should-not-exist', cwd: 'no-such-folder' });
  expect(body.exit_code === 2 && output(body).includes('nothing was run'), output(body));
  const check = await call('computer_run', { computer, command: 'ls should-not-exist 2>/dev/null | wc -l' });
  expect(output(check.body).trim() === '0', 'file was created');
});
await step('background leftovers end with the command', async () => {
  await call('computer_run', { computer, command: 'sleep 4501 & echo started' });
  const { body } = await call('computer_run', { computer, command: "sleep 3; ps -eo args | grep -c '[s]leep 4501' || true" });
  expect(output(body).trim() === '0', `left: ${output(body).trim()}`);
});
await step('stopping the call ends everything it started', async () => {
  const controller = new AbortController();
  const pending = client.callTool({ name: 'computer_run', arguments: { computer, command: '(sleep 4601 &); setsid sleep 4602 & sleep 4603' } }, undefined, { signal: controller.signal, timeout: 120_000 });
  setTimeout(() => controller.abort('stop'), 8000);
  await pending.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  const { body } = await call('computer_run', { computer, command: "ps -eo args | grep -c '[s]leep 460[123]' || true" });
  expect(output(body).trim() === '0', `left: ${output(body).trim()}`);
  return '0 processes left';
});
await step('a bad job id is refused before anything runs', async () => {
  const { body } = await call('computer_job', { computer, job: 'job-deadbeef00; id #', cancel: true });
  expect(body.code === 'BAD_JOB', JSON.stringify(body));
});
await step('browser open and snapshot', async () => {
  const open = await call('computer_browser', { computer, args: ['open', 'https://example.com'] });
  expect(output(open.body).includes('Example Domain'), output(open.body));
  const snap = await call('computer_browser', { computer, args: ['snapshot', '-i'] });
  expect(output(snap.body).includes('ref='), output(snap.body));
});
await step('browser screenshot comes back as an image', async () => {
  const { images } = await call('computer_browser', { computer, args: ['screenshot'] });
  expect(images === 1, 'no image');
});
await step('copy in and out of the Library', async () => {
  const name = `probe-${provider}-${Date.now()}.txt`;
  const inn = await call('computer_copy_in', { computer, library_path: 'note.txt', destination: 'note.txt', replace: true });
  expect(!inn.result.isError, JSON.stringify(inn.body));
  const out = await call('computer_copy_out', { computer, source: 'note.txt', library_path: name });
  expect(out.body.bytes === 23, JSON.stringify(out.body));
  const again = await call('computer_copy_out', { computer, source: 'note.txt', library_path: name });
  expect(again.body.code === 'DESTINATION_EXISTS', 'overwrote a Library file');
});
await step('save and use a tool', async () => {
  await call('computer_save_tool', { computer, name: 'shout', description: 'Uppercases its argument.', script: 'echo "$1" | tr a-z A-Z' });
  const listed = await call('computer_tools', { computer });
  expect(listed.body.tools?.some((t) => t.name === 'shout'), JSON.stringify(listed.body));
  const used = await call('computer_use_tool', { computer, name: 'shout', args: ['works'] });
  expect(output(used.body).trim() === 'WORKS', output(used.body));
});
await step('stop ends running work and keeps sign-ins', async () => {
  await call('computer_browser', { computer, args: ['eval', 'document.cookie = "probe=kept; max-age=86400; path=/"; document.cookie'] });
  const started = await call('computer_run', { computer, command: 'sleep 4700' });
  expect(started.body.job, `run before stop: ${JSON.stringify(started.body).slice(0, 200)}`);
  const stop = await call('computer_stop', { computer });
  expect(stop.body.state === 'stopped', JSON.stringify(stop.body));
  const job = await call('computer_job', { computer, job: started.body.job });
  // Fly resets the machine's root disk on restart, so the job record itself is gone; either way it is not running.
  expect(job.body.state === 'stopped' || job.body.code === 'JOB_NOT_FOUND', `job after stop: ${job.body.state ?? job.body.code}`);
  await call('computer_browser', { computer, args: ['open', 'https://example.com'] });
  const cookie = await call('computer_browser', { computer, args: ['eval', 'document.cookie'] });
  expect(output(cookie.body).includes('probe=kept'), output(cookie.body));
  return `job ${job.body.stopped_reason ?? 'forgotten by the restart'}; cookie kept`;
});
await step('remove', async () => {
  const { body } = await call('computer_remove', { computer });
  expect(body.removed === computer, JSON.stringify(body));
  const { body: list } = await call('computer_list', {});
  expect(!list.computers.some((c) => c.name === computer), 'still listed');
});

await client.close();
const status = steps.every((s) => s.status === 'pass') ? 'pass' : 'fail';
const report = { connector: 'computers', package: '@mindstone/mcp-server-computers', version: '0.1.0', provider, status, timestamp: new Date().toISOString(), steps };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`${provider}: ${status}`);
for (const s of steps) console.log(`  ${s.status === 'pass' ? 'ok ' : 'FAIL'} ${s.step} (${s.seconds}s)${s.status === 'fail' ? ` — ${s.detail}` : ''}`);
