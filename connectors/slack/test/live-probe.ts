#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Slack OSS server — live API probe gate.
 *
 * NOT auto-run. Trigger with `npm run probe:live`. Runs against the *packed*
 * tarball (mimicking the published install) — packs `npm pack`, extracts to a
 * temp dir, spawns the bin via stdio, and exercises:
 *   1. initialize
 *   2. tools/list
 *   3. 5 read-only tool calls
 *   4. 2 write tool calls
 *
 * Logs `search.messages` P95 latency so the 60s timeout default is grounded
 * in measured data (postmortem 260421 invariant).
 *
 * Required env:
 *   LIVE_PROBE_BOT_TOKEN     xoxb-...    (bot token of a real workspace)
 *   LIVE_PROBE_USER_TOKEN    xoxp-...    (user token, granted at OAuth)
 *   LIVE_PROBE_TEAM_ID       T...        (workspace team ID)
 *
 * Optional:
 *   LIVE_PROBE_TEST_CHANNEL_ID  C...     (channel to post the test message into;
 *                                         falls back to skipping write probes)
 *   LIVE_PROBE_REQUIRE_WRITES   1        (publish-gate mode: fail if writes are
 *                                         skipped or fail. Set by probe:live:gate.)
 *   LIVE_PROBE_KEEP_ARTIFACTS  1         (skip cleanup of the temp packed dir)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface ProbeResult {
  step: string;
  ok: boolean;
  durationMs: number;
  details?: unknown;
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

async function packTarball(packageRoot: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-probe-pack-'));
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['pack', '--pack-destination', tmpDir], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`npm pack failed with code ${code}`));
      const tarballName = stdout.trim().split('\n').pop()!;
      resolve(path.join(tmpDir, tarballName));
    });
  });
}

async function extractTarball(tarball: string): Promise<string> {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-probe-extract-'));
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tarball, '-C', extractDir, '--strip-components=1'], {
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`tar -xzf failed with code ${code}`));
      resolve();
    });
  });
  // Install only production deps so the probe runs against the same
  // dependency graph an `npx -y @mindstone-engineering/mcp-server-slack`
  // user would get. --no-package-lock keeps it fast; --omit=dev cuts
  // vitest/msw/tsx noise. The probe is exercising runtime, not build.
  console.log(`[live-probe] Installing production deps in ${extractDir}…`);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts'],
      { cwd: extractDir, stdio: 'inherit' },
    );
    proc.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`npm install in extracted dir failed (code ${code})`));
      resolve();
    });
  });
  return extractDir;
}

async function main() {
  const botToken = process.env.LIVE_PROBE_BOT_TOKEN;
  const userToken = process.env.LIVE_PROBE_USER_TOKEN;
  const teamId = process.env.LIVE_PROBE_TEAM_ID;
  if (!botToken || !userToken || !teamId) {
    console.error(
      'Missing one or more of LIVE_PROBE_BOT_TOKEN, LIVE_PROBE_USER_TOKEN, LIVE_PROBE_TEAM_ID',
    );
    process.exit(1);
  }

  const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  console.log(`[live-probe] Packing ${packageRoot}…`);
  const tarball = await packTarball(packageRoot);
  console.log(`[live-probe] Packed: ${tarball}`);
  const extracted = await extractTarball(tarball);
  console.log(`[live-probe] Extracted to: ${extracted}`);

  // Build a synthetic config dir that mirrors what the desktop service writes.
  const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-probe-config-'));
  fs.writeFileSync(
    path.join(configPath, 'config.json'),
    JSON.stringify({
      workspaces: [{ teamId, teamName: 'Live Probe', authedAt: new Date().toISOString() }],
    }),
  );
  fs.mkdirSync(path.join(configPath, 'workspaces'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configPath, 'workspaces', `${teamId}.json`),
    JSON.stringify(
      {
        botToken,
        userToken,
        botUserId: 'PROBE',
        // No refresh tokens → tokens treated as non-rotating, no refresh attempted.
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const binPath = path.join(extracted, 'dist', 'index.js');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [binPath],
    env: {
      ...process.env,
      SLACK_CONFIG_PATH: configPath,
      SLACK_TEAM_ID: teamId,
      SLACK_CLIENT_ID: 'live-probe-client-id',
      SLACK_CLIENT_SECRET: 'live-probe-client-secret',
    },
  });
  const client = new Client({ name: 'live-probe', version: '0.0.0' });
  await client.connect(transport);

  const results: ProbeResult[] = [];
  const searchLatencies: number[] = [];
  const measure = async (step: string, fn: () => Promise<unknown>) => {
    const start = performance.now();
    try {
      const details = await fn();
      const ms = performance.now() - start;
      results.push({ step, ok: true, durationMs: ms, details });
      console.log(`[live-probe] OK ${step} ${ms.toFixed(0)}ms`);
      if (step.startsWith('search.messages.')) searchLatencies.push(ms);
    } catch (err) {
      const ms = performance.now() - start;
      results.push({ step, ok: false, durationMs: ms, details: String(err) });
      console.error(`[live-probe] FAIL ${step} ${ms.toFixed(0)}ms — ${String(err)}`);
    }
  };

  // initialize + tools/list
  await measure('tools/list', () => client.listTools());

  // 5 read-only tools
  await measure('list_slack_workspaces', () =>
    client.callTool({ name: 'list_slack_workspaces', arguments: {} }),
  );
  await measure('list_slack_channels', () =>
    client.callTool({ name: 'list_slack_channels', arguments: { limit: 10 } }),
  );
  await measure('list_slack_users', () =>
    client.callTool({ name: 'list_slack_users', arguments: { limit: 10 } }),
  );
  for (let i = 0; i < 3; i++) {
    await measure(`search.messages.${i + 1}`, () =>
      client.callTool({
        name: 'search_slack_messages',
        arguments: { query: 'meeting', count: 5 },
      }),
    );
  }

  // 2 write tools — only if a test channel ID is provided (avoid spamming a real workspace).
  // In publish-gate mode (LIVE_PROBE_REQUIRE_WRITES=1) we MUST run writes, so
  // a missing test channel is a hard failure rather than a silent skip.
  const testChannel = process.env.LIVE_PROBE_TEST_CHANNEL_ID;
  const requireWrites =
    process.env.LIVE_PROBE_REQUIRE_WRITES === '1' ||
    process.env.LIVE_PROBE_REQUIRE_WRITES?.toLowerCase() === 'true';
  let writesSkipped = false;
  let postedSucceeded = false;
  let reactedSucceeded = false;
  if (testChannel) {
    let postedTs: string | undefined;
    await measure('post_slack_message', async () => {
      const r = (await client.callTool({
        name: 'post_slack_message',
        arguments: { channel: testChannel, text: '[live-probe] hi from packed tarball' },
      })) as { content: Array<{ text?: string }> };
      const parsed = JSON.parse(r.content[0]?.text ?? '{}');
      if (parsed?.ok !== true) {
        throw new Error(`post_slack_message did not return ok:true — ${JSON.stringify(parsed).slice(0, 200)}`);
      }
      postedTs = parsed.ts_slack;
      postedSucceeded = true;
      return parsed;
    });
    if (postedTs) {
      await measure('add_slack_reaction', async () => {
        const r = (await client.callTool({
          name: 'add_slack_reaction',
          arguments: { channel: testChannel, timestamp: postedTs, name: 'eyes' },
        })) as { content: Array<{ text?: string }> };
        const parsed = JSON.parse(r.content[0]?.text ?? '{}');
        if (parsed?.ok !== true) {
          throw new Error(`add_slack_reaction did not return ok:true — ${JSON.stringify(parsed).slice(0, 200)}`);
        }
        reactedSucceeded = true;
        return parsed;
      });
    }
  } else {
    writesSkipped = true;
    console.log('[live-probe] skipping write probes — set LIVE_PROBE_TEST_CHANNEL_ID to enable');
  }

  await client.close();

  // search.messages P95
  if (searchLatencies.length > 0) {
    const sorted = [...searchLatencies].sort((a, b) => a - b);
    const p50 = quantile(sorted, 0.5);
    const p95 = quantile(sorted, 0.95);
    console.log(
      `[live-probe] search.messages latency: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (n=${sorted.length})`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`[live-probe] ${failed.length} steps failed`);
  }

  // Publish-gate mode: writes are mandatory. Skipping or partial-success
  // counts as a gate failure even if no individual step threw.
  let gateFailed = false;
  if (requireWrites) {
    if (writesSkipped) {
      console.error(
        '[live-probe] PUBLISH-GATE FAIL: LIVE_PROBE_REQUIRE_WRITES=1 set but LIVE_PROBE_TEST_CHANNEL_ID is missing — write probes were skipped.',
      );
      gateFailed = true;
    } else if (!postedSucceeded || !reactedSucceeded) {
      console.error(
        `[live-probe] PUBLISH-GATE FAIL: write probes did not all succeed (postedSucceeded=${postedSucceeded}, reactedSucceeded=${reactedSucceeded}).`,
      );
      gateFailed = true;
    } else {
      console.log('[live-probe] PUBLISH-GATE OK: write probes ran cleanly.');
    }
  }

  if (process.env.LIVE_PROBE_KEEP_ARTIFACTS !== '1') {
    fs.rmSync(extracted, { recursive: true, force: true });
    fs.rmSync(configPath, { recursive: true, force: true });
    fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
  } else {
    console.log(`[live-probe] keeping artefacts: ${extracted}, ${configPath}, ${path.dirname(tarball)}`);
  }

  process.exit(failed.length > 0 || gateFailed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
