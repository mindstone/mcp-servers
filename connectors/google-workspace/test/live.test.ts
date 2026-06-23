import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const LIVE_ENABLED = process.env.MCP_GOOGLE_WORKSPACE_LIVE_PROBE === '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Live-probe configuration is driven entirely by env vars so no developer-specific
// paths or account identities are committed. Defaults are neutral placeholders; a dev
// running the probe (MCP_GOOGLE_WORKSPACE_LIVE_PROBE=1) sets these to their real values.
const hostRoot = process.env.MCP_GW_LIVE_HOST_ROOT ?? path.join(os.homedir(), 'MindstoneRebel');
const liveAccount = process.env.MCP_GW_LIVE_ACCOUNT ?? 'jane-example-com';
const instanceRoot = path.join(
  os.homedir(),
  `Library/Application Support/mindstone-rebel/google-workspace-mcp/GoogleWorkspace-${liveAccount}`,
);
const accountsPath = path.join(instanceRoot, 'accounts.json');
const credentialsPath = path.join(instanceRoot, 'credentials');
const tokenFileName = `${liveAccount}.token.json`;
const tokenPath = path.join(credentialsPath, tokenFileName);
const reportPath = path.join(root, 'reports/live-probe-google-workspace.json');

type LiveResult = {
  tool: string;
  service: string;
  ok: boolean;
  latencyMs: number;
  skipped?: boolean;
  skipReason?: string;
  error?: string;
};

type LiveReport = {
  generatedAt: string;
  packageTarball?: string;
  initialize: { ok: boolean; serverVersion?: unknown; serverCapabilities?: unknown; error?: string };
  toolList: { ok: boolean; count?: number; expected?: number; sampledAnnotations?: unknown[]; error?: string };
  readOnly: LiveResult[];
  writes: LiveResult[];
  scratchResources: {
    gmailLabel: { found: boolean; id?: string };
    calendar: { found: boolean; id?: string };
    driveFolder: { found: boolean; id?: string };
  };
  oauthRefresh: {
    enabledRefresh?: { ok: boolean; expiryAdvanced?: boolean; modePreserved?: boolean; error?: string };
    disableRefresh?: { ok: boolean; authRequired?: boolean; tokenFileUnchanged?: boolean; error?: string };
  };
  latency: { p95Ms?: number; thresholdMs: number; ok?: boolean };
  finalExitStatus: 'pass' | 'partial' | 'fail';
  errors: string[];
};

type ProbeClient = {
  client: Client;
  transport: StdioClientTransport;
};

let tempRoots: string[] = [];
let activeClients: ProbeClient[] = [];

function readEmbeddedGoogleOAuthCredentials(): { clientId: string; clientSecret: string } {
  const source = fs.readFileSync(path.join(hostRoot, 'src/core/services/oauthCredentials.ts'), 'utf8');
  const googleBlock = source.match(/google:\s*{([\s\S]*?)}/)?.[1] ?? '';
  const clientId = googleBlock.match(/clientId:\s*'([^']+)'/)?.[1];
  const clientSecret = googleBlock.match(/clientSecret:\s*'([^']+)'/)?.[1];
  if (!clientId || !clientSecret) {
    throw new Error('Unable to locate embedded Google OAuth credentials');
  }
  return { clientId, clientSecret };
}

function preparePackedServer(): { entryPoint: string; tarballName: string; workspacePath: string } {
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-live-probe-pack-'));
  tempRoots.push(packRoot);
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packRoot], {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  const tarballName = output.split('\n').at(-1);
  if (!tarballName) {
    throw new Error('npm pack did not return a tarball name');
  }
  const tarballPath = path.join(packRoot, tarballName);
  const extractRoot = path.join(packRoot, 'extract');
  fs.mkdirSync(extractRoot);
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractRoot], { stdio: 'pipe' });
  const packageRoot = path.join(extractRoot, 'package');
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts'], { cwd: packageRoot, stdio: 'pipe' });
  const workspacePath = path.join(packRoot, 'workspace');
  fs.mkdirSync(workspacePath, { mode: 0o700 });
  return {
    entryPoint: path.join(packageRoot, 'dist/index.js'),
    tarballName,
    workspacePath,
  };
}

async function spawnProbeClient(entryPoint: string, workspacePath: string, extraEnv: Record<string, string> = {}): Promise<ProbeClient> {
  const credentials = readEmbeddedGoogleOAuthCredentials();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    env: {
      HOME: process.env.HOME ?? os.homedir(),
      PATH: process.env.PATH ?? '',
      GOOGLE_CLIENT_ID: credentials.clientId,
      GOOGLE_CLIENT_SECRET: credentials.clientSecret,
      ACCOUNTS_PATH: accountsPath,
      CREDENTIALS_PATH: credentialsPath,
      ENABLE_GOOGLE_TASKS_FORMS: 'true',
      MCP_WORKSPACE_PATH: workspacePath,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'google-workspace-live-probe', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const probeClient = { client, transport };
  activeClients.push(probeClient);
  return probeClient;
}

function parseToolPayload(result: { content?: unknown }): unknown {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const textBlock = blocks.find((block): block is { type: string; text: string } => {
    return typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string';
  });
  if (!textBlock) return result;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

async function callTool(
  probe: ProbeClient,
  report: LiveReport,
  service: string,
  name: string,
  args: Record<string, unknown>,
  options: { allowError?: boolean; bucket?: 'readOnly' | 'writes' } = {},
): Promise<{ payload: unknown; isError: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    const result = await probe.client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const latencyMs = Math.round(performance.now() - started);
    const isError = result.isError === true;
    const payload = parseToolPayload(result);
    const row: LiveResult = { tool: name, service, ok: !isError, latencyMs };
    if (isError) {
      row.error = JSON.stringify(payload);
      if (options.allowError) {
        row.ok = true;
        row.skipped = true;
        row.skipReason = row.error;
      }
      if (!options.allowError) report.errors.push(`${name}: ${row.error}`);
    }
    report[options.bucket ?? 'readOnly'].push(row);
    if (isError && !options.allowError) {
      throw new Error(`${name} returned error: ${JSON.stringify(payload)}`);
    }
    return { payload, isError, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const row: LiveResult = {
      tool: name,
      service,
      ok: options.allowError === true,
      latencyMs,
      skipped: options.allowError === true ? true : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
    if (options.allowError) {
      row.skipReason = row.error;
    }
    report[options.bucket ?? 'readOnly'].push(row);
    if (!options.allowError) report.errors.push(`${name}: ${row.error}`);
    if (!options.allowError) throw error;
    return { payload: row.error, isError: true, latencyMs };
  }
}

function objectsFrom(value: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== 'object' || candidate === null) return;
    const record = candidate as Record<string, unknown>;
    out.push(record);
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return out;
}

function findObjectByName(payload: unknown, name: string): Record<string, unknown> | undefined {
  return objectsFrom(payload).find((item) => item.name === name || item.summary === name || item.title === name);
}

function findFileByMime(payload: unknown, mimeType: string): Record<string, unknown> | undefined {
  return objectsFrom(payload).find((item) => item.mimeType === mimeType && typeof item.id === 'string');
}

function firstStringId(payload: unknown): string | undefined {
  return objectsFrom(payload).map(item => item.id).find((id): id is string => typeof id === 'string');
}

function percentile95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function copyCredentialInstance(backdate: boolean): { accounts: string; credentials: string; token: string; workspace: string } {
  const instance = fs.mkdtempSync(path.join(os.tmpdir(), 'gws-live-probe-credentials-'));
  tempRoots.push(instance);
  const targetCredentials = path.join(instance, 'credentials');
  fs.mkdirSync(targetCredentials, { mode: 0o700 });
  const targetAccounts = path.join(instance, 'accounts.json');
  const targetToken = path.join(targetCredentials, tokenFileName);
  fs.copyFileSync(accountsPath, targetAccounts);
  fs.copyFileSync(tokenPath, targetToken);
  fs.chmodSync(targetToken, 0o600);
  if (backdate) {
    const token = JSON.parse(fs.readFileSync(targetToken, 'utf8')) as Record<string, unknown>;
    token.expiry_date = Date.now() - 60_000;
    fs.writeFileSync(targetToken, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  }
  const workspace = path.join(instance, 'workspace');
  fs.mkdirSync(workspace, { mode: 0o700 });
  return { accounts: targetAccounts, credentials: targetCredentials, token: targetToken, workspace };
}

function writeReport(report: LiveReport): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

afterEach(async () => {
  for (const probe of activeClients.splice(0)) {
    await probe.client.close().catch(() => undefined);
  }
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

(LIVE_ENABLED ? describe : describe.skip)('Google Workspace opt-in live probe', () => {
  it('runs against the packed tarball using host-orchestrated credentials', async () => {
    const report: LiveReport = {
      generatedAt: new Date().toISOString(),
      initialize: { ok: false },
      toolList: { ok: false, expected: 104 },
      readOnly: [],
      writes: [],
      scratchResources: {
        gmailLabel: { found: false },
        calendar: { found: false },
        driveFolder: { found: false },
      },
      oauthRefresh: {},
      latency: { thresholdMs: 45_000 },
      finalExitStatus: 'fail',
      errors: [],
    };

    try {
      expect(fs.existsSync(accountsPath)).toBe(true);
      expect(fs.existsSync(tokenPath)).toBe(true);

      const packed = preparePackedServer();
      report.packageTarball = packed.tarballName;
      const probe = await spawnProbeClient(packed.entryPoint, packed.workspacePath);
      report.initialize = {
        ok: true,
        serverVersion: probe.client.getServerVersion(),
        serverCapabilities: probe.client.getServerCapabilities(),
      };

      const tools = await probe.client.listTools(undefined, { timeout: 60_000 });
      report.toolList.ok = true;
      report.toolList.count = tools.tools.length;
      const destructiveOverrides = await import(pathToFileURL(path.join(root, 'dist/tools/definitions/destructive-overrides.json')).href, { assert: { type: 'json' } }) as { default: Record<string, boolean> };
      const openWorldOverrides = await import(pathToFileURL(path.join(root, 'dist/tools/definitions/open-world-overrides.json')).href, { assert: { type: 'json' } }) as { default: Record<string, boolean> };
      const sampleTools = [
        'send_workspace_email',
        'list_drive_files',
        'delete_workspace_calendar_event',
        'list_workspace_accounts',
        'create_task',
      ];
      report.toolList.sampledAnnotations = sampleTools.map((name) => {
        const tool = tools.tools.find(candidate => candidate.name === name);
        expect(tool?.annotations?.destructiveHint).toBe(destructiveOverrides.default[name]);
        expect(tool?.annotations?.openWorldHint).toBe(openWorldOverrides.default[name]);
        return { tool: name, annotations: tool?.annotations };
      });
      expect(tools.tools).toHaveLength(104);

      await callTool(probe, report, 'local', 'list_workspace_accounts', {});
      await callTool(probe, report, 'gmail', 'search_workspace_emails', { query: 'rebel-oss-live-probe', max_results: 5, return_json: true });
      await callTool(probe, report, 'calendar', 'list_workspace_calendar_events', { calendar_id: 'primary', max_results: 5, return_json: true });
      const driveList = await callTool(probe, report, 'drive', 'list_drive_files', { options: { query: '', pageSize: 5 }, return_json: true });

      const scratchFolder = findObjectByName(
        (await callTool(probe, report, 'drive', 'list_drive_files', {
          options: {
            query: "mimeType = 'application/vnd.google-apps.folder' and name = 'Rebel OSS Live Probe Scratch' and trashed = false",
            pageSize: 10,
          },
          return_json: true,
        })).payload,
        'Rebel OSS Live Probe Scratch',
      );
      if (typeof scratchFolder?.id === 'string') {
        report.scratchResources.driveFolder = { found: true, id: scratchFolder.id };
      }

      async function findScratchFile(mimeType: string): Promise<string | undefined> {
        if (report.scratchResources.driveFolder.id) {
          const result = await callTool(probe, report, 'drive', 'list_drive_files', {
            options: {
              folderId: report.scratchResources.driveFolder.id,
              query: `mimeType = '${mimeType}' and trashed = false`,
              pageSize: 5,
            },
            return_json: true,
          });
          const file = findFileByMime(result.payload, mimeType);
          if (typeof file?.id === 'string') return file.id;
        }
        const fallback = findFileByMime(driveList.payload, mimeType);
        if (typeof fallback?.id === 'string') return fallback.id;

        const filteredFallback = await callTool(probe, report, 'drive', 'list_drive_files', {
          options: {
            query: `mimeType = '${mimeType}' and trashed = false`,
            pageSize: 5,
          },
          return_json: true,
        }, { allowError: true });
        const filteredFile = findFileByMime(filteredFallback.payload, mimeType);
        return typeof filteredFile?.id === 'string' ? filteredFile.id : undefined;
      }

      const docId = await findScratchFile('application/vnd.google-apps.document');
      if (docId) {
        await callTool(probe, report, 'docs', 'read_workspace_document', { document_id: docId, max_chars: 4000, return_json: true });
      } else {
        report.readOnly.push({ tool: 'read_workspace_document', service: 'docs', ok: true, skipped: true, skipReason: 'No scratch or fallback Google Doc found', latencyMs: 0 });
      }

      const sheetId = await findScratchFile('application/vnd.google-apps.spreadsheet');
      if (sheetId) {
        await callTool(probe, report, 'sheets', 'read_workspace_spreadsheet', { spreadsheet_id: sheetId, max_rows: 20, max_cols: 10, return_json: true, anchor_mode: 'never' });
      } else {
        report.readOnly.push({ tool: 'read_workspace_spreadsheet', service: 'sheets', ok: true, skipped: true, skipReason: 'No scratch or fallback Google Sheet found', latencyMs: 0 });
      }

      const slidesId = await findScratchFile('application/vnd.google-apps.presentation');
      if (slidesId) {
        await callTool(probe, report, 'slides', 'read_workspace_presentation', { presentation_id: slidesId, max_chars: 4000, return_json: true });
      } else {
        report.readOnly.push({ tool: 'read_workspace_presentation', service: 'slides', ok: true, skipped: true, skipReason: 'No scratch or fallback Google Slides file found', latencyMs: 0 });
      }

      await callTool(probe, report, 'contacts', 'get_workspace_contacts', { person_fields: 'names,emailAddresses', page_size: 5 });
      await callTool(probe, report, 'tasks', 'list_tasks', { task_list_id: '@default', max_results: 5 }, { allowError: true });

      const formsList = await callTool(probe, report, 'forms', 'list_forms', { max_results: 5 }, { allowError: true });
      const formId = firstStringId(formsList.payload);
      if (formId) {
        await callTool(probe, report, 'forms', 'list_form_responses', { form_id: formId, max_results: 5 });
      } else {
        report.readOnly.push({ tool: 'list_form_responses', service: 'forms', ok: true, skipped: true, skipReason: 'No Google Forms found for this account', latencyMs: 0 });
      }

      const labels = await callTool(probe, report, 'gmail', 'list_workspace_labels', {});
      const scratchLabel = findObjectByName(labels.payload, 'rebel-oss-live-probe');
      if (typeof scratchLabel?.id === 'string') {
        report.scratchResources.gmailLabel = { found: true, id: scratchLabel.id };
      }

      const calendars = await callTool(probe, report, 'calendar', 'list_workspace_calendars', {});
      const scratchCalendar = findObjectByName(calendars.payload, 'Rebel OSS Live Probe');
      if (typeof scratchCalendar?.id === 'string') {
        report.scratchResources.calendar = { found: true, id: scratchCalendar.id };
      }

      if (report.scratchResources.gmailLabel.id) {
        const recentUnread = await callTool(probe, report, 'gmail', 'search_workspace_emails', {
          query: 'is:unread',
          max_results: 1,
          return_json: true,
        }, { allowError: true });
        const messageId = firstStringId(recentUnread.payload);
        if (messageId) {
          await callTool(probe, report, 'gmail', 'manage_workspace_label_assignment', {
            action: 'add',
            message_id: messageId,
            label_ids: [report.scratchResources.gmailLabel.id],
          }, { bucket: 'writes' });
          await callTool(probe, report, 'gmail', 'search_workspace_emails', {
            query: `label:rebel-oss-live-probe rfc822msgid:${messageId}`,
            max_results: 1,
            return_json: true,
          }, { bucket: 'writes', allowError: true });
          await callTool(probe, report, 'gmail', 'manage_workspace_label_assignment', {
            action: 'remove',
            message_id: messageId,
            label_ids: [report.scratchResources.gmailLabel.id],
          }, { bucket: 'writes' });
        } else {
          report.writes.push({ tool: 'manage_workspace_label_assignment', service: 'gmail', ok: true, skipped: true, skipReason: 'Scratch label exists but no unread email was available', latencyMs: 0 });
        }
      } else {
        report.writes.push({ tool: 'manage_workspace_label_assignment', service: 'gmail', ok: true, skipped: true, skipReason: 'Scratch Gmail label not found', latencyMs: 0 });
      }

      if (report.scratchResources.calendar.id) {
        const start = new Date(Date.now() + 60 * 60 * 1000);
        const end = new Date(start.getTime() + 5 * 60 * 1000);
        const title = `OSS Live Probe — DELETE ME — ${new Date().toISOString()}`;
        const created = await callTool(probe, report, 'calendar', 'create_workspace_calendar_event', {
          calendar_id: report.scratchResources.calendar.id,
          summary: title,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
        }, { bucket: 'writes' });
        const eventId = firstStringId(created.payload);
        if (eventId) {
          await callTool(probe, report, 'calendar', 'list_workspace_calendar_events', {
            calendar_id: report.scratchResources.calendar.id,
            query: title,
            max_results: 5,
            return_json: true,
          }, { bucket: 'writes' });
          await callTool(probe, report, 'calendar', 'delete_workspace_calendar_event', {
            calendar_id: report.scratchResources.calendar.id,
            event_id: eventId,
            send_updates: 'none',
          }, { bucket: 'writes' });
        }
      } else {
        report.writes.push({ tool: 'create_workspace_calendar_event/delete_workspace_calendar_event', service: 'calendar', ok: true, skipped: true, skipReason: 'Scratch calendar not found', latencyMs: 0 });
      }

      const refreshEnabled = copyCredentialInstance(true);
      const refreshProbe = await spawnProbeClient(packed.entryPoint, refreshEnabled.workspace, {
        ACCOUNTS_PATH: refreshEnabled.accounts,
        CREDENTIALS_PATH: refreshEnabled.credentials,
        GOOGLE_WORKSPACE_DISABLE_REFRESH: '0',
      });
      await callTool(refreshProbe, report, 'calendar', 'list_workspace_calendar_events', { calendar_id: 'primary', max_results: 1, return_json: true }, { allowError: false });
      const refreshedToken = JSON.parse(fs.readFileSync(refreshEnabled.token, 'utf8')) as { expiry_date?: number };
      const refreshedMode = fs.statSync(refreshEnabled.token).mode & 0o777;
      report.oauthRefresh.enabledRefresh = {
        ok: (refreshedToken.expiry_date ?? 0) > Date.now(),
        expiryAdvanced: (refreshedToken.expiry_date ?? 0) > Date.now(),
        modePreserved: refreshedMode === 0o600,
      };
      expect(report.oauthRefresh.enabledRefresh.ok).toBe(true);
      expect(report.oauthRefresh.enabledRefresh.modePreserved).toBe(true);

      const refreshDisabled = copyCredentialInstance(true);
      const originalDisabledToken = fs.readFileSync(refreshDisabled.token, 'utf8');
      const disabledProbe = await spawnProbeClient(packed.entryPoint, refreshDisabled.workspace, {
        ACCOUNTS_PATH: refreshDisabled.accounts,
        CREDENTIALS_PATH: refreshDisabled.credentials,
        GOOGLE_WORKSPACE_DISABLE_REFRESH: '1',
      });
      const disabledResult = await callTool(
        disabledProbe,
        report,
        'calendar',
        'list_workspace_calendar_events',
        { calendar_id: 'primary', max_results: 1, return_json: true },
        { allowError: true },
      );
      const tokenFileUnchanged = fs.readFileSync(refreshDisabled.token, 'utf8') === originalDisabledToken;
      report.oauthRefresh.disableRefresh = {
        ok: disabledResult.isError && tokenFileUnchanged && JSON.stringify(disabledResult.payload).includes('auth_required'),
        authRequired: JSON.stringify(disabledResult.payload).includes('auth_required'),
        tokenFileUnchanged,
      };
      expect(report.oauthRefresh.disableRefresh.ok).toBe(true);

      const latencies = [...report.readOnly, ...report.writes]
        .filter(result => !result.skipped && result.latencyMs > 0)
        .map(result => result.latencyMs);
      const p95 = percentile95(latencies);
      report.latency.p95Ms = p95;
      report.latency.ok = p95 === undefined || p95 <= report.latency.thresholdMs;
      expect(report.latency.ok).toBe(true);

      const nonSkippedFailures = [...report.readOnly, ...report.writes].filter(result => !result.ok && !result.skipped);
      report.finalExitStatus = nonSkippedFailures.length === 0 && report.errors.length === 0 ? 'pass' : 'partial';
      expect(report.initialize.ok).toBe(true);
      expect(report.toolList.count).toBe(104);
    } catch (error) {
      report.errors.push(error instanceof Error ? error.message : String(error));
      report.finalExitStatus = 'fail';
      throw error;
    } finally {
      writeReport(report);
    }
  }, 300_000);
});
