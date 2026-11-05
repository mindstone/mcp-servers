/**
 * Fly.io: each computer is a Machine with its own volume mounted as root's home, in one app the
 * connector owns (found by its `mcp-computers-` prefix, or named in FLY_APP).
 *
 * Commands go through the Machines API's own exec (about 60 s per call and a small request body),
 * so files go through a tiny file service on the computer, reached over the app's HTTPS address and
 * routed to the right machine with `fly-force-instance-id`. The machine's root filesystem is reset
 * whenever Fly restarts it, so everything that must last lives in the volume, and a boot hook there
 * brings the file service and the idle stop back.
 */
import { randomBytes } from 'node:crypto';
import { ConnectorError } from '../types.js';
import { MAX_FILE_BYTES } from '../library.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { type ComputerInfo, type ComputerState, type ExecResult, type Provider, TOOLBOX, extraLabels, sleep } from '../provider.js';

const API = 'https://api.machines.dev/v1';
const IMAGE = 'mcr.microsoft.com/playwright:v1.49.1-noble';
const APP_PREFIX = 'mcp-computers-';
const TOKEN_URL = 'https://fly.io/dashboard/personal/tokens';
const BOOT = '/root/.mcp-computer-boot.sh';
/** Written by the boot hook once the everyday tools are back (Fly resets the root disk on every start). */
const TOOLS_READY = '/var/lib/mcp-computer/tools-ready';

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  created_at: string;
  config?: { metadata?: Record<string, string>; mounts?: Array<{ volume: string }> };
}

export class FlyProvider implements Provider {
  readonly id = 'fly' as const;
  readonly label = 'Fly.io';
  readonly user = 'root';
  readonly home = '/root';
  readonly execLimitSec = 55;
  /** Ends the machine's main process (the boot hook's idle loop, or the first boot's sleep), which stops it. */
  readonly idleShutdown = 'pkill -x sleep || true';
  private app: string | undefined;
  private fileKeys = new Map<string, string>();

  constructor(
    private readonly token: string,
    private readonly org: string,
    appName: string | undefined,
    private readonly region: string,
  ) {
    this.app = appName || undefined;
  }

  private async api<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ConnectorError(
        'Fly.io could not be reached.',
        'PROVIDER_UNREACHABLE',
        'Check the internet connection and try again in a minute. If it keeps failing, see https://status.flyio.net.',
      );
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch {
        // Never echo the body: it could reflect the token.
        throw new ConnectorError('Fly.io gave a reply the connector could not read.', 'PROVIDER_ERROR', 'Try again in a minute.');
      }
    }
    throw flyError(response.status, text.split(this.token).join('[key removed]'), path);
  }

  async check(): Promise<string> {
    const app = await this.findApp(false);
    if (app) {
      const machines = await this.machines(app);
      return `Fly.io: the token works. Computers live in the app "${app}" (${machines.length} so far).`;
    }
    await this.api('GET', `/apps?org_slug=${encodeURIComponent(this.org)}`);
    return `Fly.io: the token works for the organization "${this.org}". The first computer you create will make an app for them.`;
  }

  private async findApp(create: boolean): Promise<string | undefined> {
    if (this.app) return this.app;
    const { apps } = await this.api<{ apps: Array<{ name: string }> }>('GET', `/apps?org_slug=${encodeURIComponent(this.org)}`);
    const found = apps?.find((app) => app.name.startsWith(APP_PREFIX));
    if (found) return (this.app = found.name);
    if (!create) return undefined;
    const name = `${APP_PREFIX}${randomBytes(4).toString('hex')}`;
    await this.api('POST', '/apps', { app_name: name, org_slug: this.org });
    await this.api('POST', `/apps/${name}/ip_assignments`, { type: 'shared_v4' });
    await this.api('POST', `/apps/${name}/ip_assignments`, { type: 'v6' });
    return (this.app = name);
  }

  private async machines(app: string): Promise<FlyMachine[]> {
    const machines = await this.api<FlyMachine[]>('GET', `/apps/${app}/machines`);
    return machines.filter((machine) => machine.config?.metadata?.['mcp-computer'] === '1');
  }

  async list(): Promise<ComputerInfo[]> {
    const app = await this.findApp(false);
    if (!app) return [];
    return (await this.machines(app)).map((machine) => this.info(machine));
  }

  private info(machine: FlyMachine): ComputerInfo {
    return { provider: 'fly', id: machine.id, name: machine.name, state: flyState(machine.state), region: machine.region, createdAt: machine.created_at };
  }

  async create(name: string): Promise<ComputerInfo> {
    const app = (await this.findApp(true))!;
    const volume = await this.api<{ id: string }>('POST', `/apps/${app}/volumes`, {
      name: `computer_${name.replace(/-/g, '_')}`.slice(0, 30),
      region: this.region,
      size_gb: 10,
      encrypted: true,
    });
    const machine = await this.api<FlyMachine>('POST', `/apps/${app}/machines`, {
      name,
      region: this.region,
      config: {
        image: IMAGE,
        init: { exec: ['/bin/bash', '-c', `[ -x ${BOOT} ] && exec ${BOOT}; exec sleep infinity`] },
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
        mounts: [{ volume: volume.id, path: '/root' }],
        services: [{ protocol: 'tcp', internal_port: 8080, autostart: false, autostop: 'off', ports: [{ port: 443, handlers: ['tls', 'http'] }] }],
        restart: { policy: 'no' },
        metadata: { 'mcp-computer': '1', ...extraLabels() },
      },
    });
    const computer = this.info(machine);
    await this.waitStarted(app, machine.id);
    computer.state = 'running';
    return computer;
  }

  private async waitStarted(app: string, id: string): Promise<void> {
    await this.api('GET', `/apps/${app}/machines/${id}/wait?state=started&timeout=60`, undefined, 75_000);
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const result = await this.execRaw(app, id, 'true', 10);
        if (result.exitCode === 0) return;
      } catch {
        // The machine is up before its exec service is; try again shortly.
      }
      await sleep(1500);
    }
    throw new ConnectorError('The computer started but is not answering yet.', 'NOT_READY', 'Wait a minute, then try the same request again.');
  }

  async start(computer: ComputerInfo): Promise<void> {
    const app = (await this.findApp(false))!;
    const machine = await this.api<FlyMachine>('GET', `/apps/${app}/machines/${computer.id}`);
    if (machine.state !== 'started') {
      // Right after a stop, Fly can refuse a start while the machine is still settling: wait and retry.
      for (let attempt = 0; ; attempt++) {
        const current = attempt === 0 ? machine : await this.api<FlyMachine>('GET', `/apps/${app}/machines/${computer.id}`);
        if (current.state === 'started' || current.state === 'starting') break;
        if (current.state === 'stopping') await this.api('GET', `/apps/${app}/machines/${computer.id}/wait?state=stopped&timeout=60`, undefined, 75_000).catch(() => undefined);
        try {
          await this.api('POST', `/apps/${app}/machines/${computer.id}/start`);
          break;
        } catch (error) {
          if (attempt >= 9) throw error;
          await sleep(3000);
        }
      }
    }
    await this.waitStarted(app, computer.id);
    // Hand the computer over only once its everyday tools are back, so the first command finds them.
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await this.execRaw(app, computer.id, `[ ! -x ${BOOT} ] || [ -f ${TOOLS_READY} ]`, 10).catch(() => undefined);
      if (ready?.exitCode === 0) return;
      await sleep(3000);
    }
  }

  async stop(computer: ComputerInfo): Promise<void> {
    const app = (await this.findApp(false))!;
    await this.api('POST', `/apps/${app}/machines/${computer.id}/stop`, { signal: 'SIGTERM', timeout: '15s' });
  }

  async remove(computer: ComputerInfo): Promise<void> {
    const app = (await this.findApp(false))!;
    const machine = await this.api<FlyMachine>('GET', `/apps/${app}/machines/${computer.id}`);
    await this.api('DELETE', `/apps/${app}/machines/${computer.id}?force=true`);
    for (const mount of machine.config?.mounts ?? []) {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await this.api('DELETE', `/apps/${app}/volumes/${mount.volume}`);
          break;
        } catch (error) {
          if (attempt === 9) throw error;
          await sleep(2000);
        }
      }
    }
  }

  private async execRaw(app: string, id: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const result = await this.api<{ stdout?: string; stderr?: string; exit_code?: number }>(
      'POST',
      `/apps/${app}/machines/${id}/exec`,
      { command: ['bash', '-c', script], timeout: Math.min(timeoutSec, 60) },
      (Math.min(timeoutSec, 60) + 15) * 1000,
    );
    return { exitCode: result.exit_code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  async exec(computer: ComputerInfo, script: string, timeoutSec: number): Promise<ExecResult> {
    return this.execRaw((await this.findApp(false))!, computer.id, script, timeoutSec);
  }

  private async fileKey(computer: ComputerInfo): Promise<string> {
    const cached = this.fileKeys.get(computer.id);
    if (cached) return cached;
    const result = await this.exec(computer, 'cat /var/lib/mcp-computer/key', 15);
    const key = result.stdout.trim();
    if (result.exitCode !== 0 || !key) throw new ConnectorError('The computer is not set up yet.', 'NOT_SET_UP', 'Run computer_setup on it, then try again.');
    this.fileKeys.set(computer.id, key);
    return key;
  }

  private async files(computer: ComputerInfo, method: 'GET' | 'PUT', path: string, mode: string, body?: Buffer): Promise<Response> {
    const app = (await this.findApp(false))!;
    const url = `https://${app}.fly.dev/files?path=${encodeURIComponent(path)}&mode=${mode}`;
    const headers = { Authorization: `Bearer ${await this.fileKey(computer)}`, 'fly-force-instance-id': computer.id };
    for (let attempt = 0; ; attempt++) {
      try {
        // redirect 'error': a computer must never be able to point a transfer at anything else (the host's own network).
        return await fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(300_000) });
      } catch (error) {
        // A just-started machine's file service can take a few seconds to come up.
        if (attempt >= 4) throw new ConnectorError('The computer did not accept the file transfer.', 'TRANSFER_FAILED', 'Try again in a minute. If it keeps failing, run computer_setup on it.');
        await sleep(2000);
      }
    }
  }

  async upload(computer: ComputerInfo, path: string, data: Buffer, mode: 'new' | 'replace'): Promise<void> {
    const response = await this.files(computer, 'PUT', path, mode, data);
    if (response.status === 409) throw new ConnectorError(`${path} already exists on the computer.`, 'DESTINATION_EXISTS', 'Choose another destination, or pass replace: true to overwrite it.');
    if (!response.ok) throw new ConnectorError(`The computer could not save ${path}.`, 'TRANSFER_FAILED', 'Check the destination folder exists and is writable, then try again.');
  }

  async download(computer: ComputerInfo, path: string): Promise<Buffer> {
    const response = await this.files(computer, 'GET', path, 'read');
    if (response.status === 404) throw new ConnectorError(`${path} does not exist on the computer.`, 'SOURCE_MISSING', 'Check the path with computer_run (for example `ls -la <folder>`).');
    if (!response.ok) throw new ConnectorError(`The computer could not read ${path}.`, 'TRANSFER_FAILED', 'Check it is a file you can read, then try again.');
    if (Number(response.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) {
      await response.body?.cancel();
      throw new ConnectorError(`${path} is larger than 200 MB.`, 'FILE_TOO_LARGE', 'Compress or split it on the computer first, then copy the parts.');
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async afterSetup(computer: ComputerInfo, run: (script: string) => Promise<ExecResult>): Promise<void> {
    const shutdown = Buffer.from(this.idleShutdown).toString('base64');
    // The root filesystem doesn't survive a restart; the volume (/root) does, so the boot hook
    // copies the runner back and starts the file service and the idle stop.
    await run(
      `umask 077; [ -s /var/lib/mcp-computer/key ] || python3 -c 'import secrets; print(secrets.token_urlsafe(24), end="")' > /var/lib/mcp-computer/key; ` +
        `mkdir -p /root/.mcp-computer-state && cp /var/lib/mcp-computer/box.py /var/lib/mcp-computer/key /root/.mcp-computer-state/; ` +
        `printf '%s\\n' '#!/bin/bash' 'mkdir -p /var/lib/mcp-computer && cp /root/.mcp-computer-state/* /var/lib/mcp-computer/' ` +
        // Fly resets the root disk on every start, so the everyday tools are reinstalled in the background.
        `'(python3 /var/lib/mcp-computer/box.py serve 8080 &)' '(apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${TOOLBOX} >/dev/null 2>&1 && touch ${TOOLS_READY}) &' 'exec python3 /var/lib/mcp-computer/box.py idle 15 ${shutdown}' > ${BOOT}; chmod 700 ${BOOT}; ` +
        `python3 /var/lib/mcp-computer/box.py daemons 15 ${shutdown} 8080`,
    );
    this.fileKeys.delete(computer.id);
  }
}

function flyState(state: string): ComputerState {
  if (state === 'started') return 'running';
  if (state === 'stopped' || state === 'suspended') return 'stopped';
  if (state === 'created' || state === 'starting' || state === 'replacing') return 'starting';
  if (state === 'stopping' || state === 'suspending') return 'stopping';
  return 'unknown';
}

function flyError(status: number, body: string, path: string): ConnectorError {
  if (status === 401)
    return new ConnectorError(
      'Fly.io did not accept the API token.',
      'AUTH_FAILED',
      `Create a token at ${TOKEN_URL} (an organization token works best), paste it into the Computers connector's Fly.io access token field, and try again.`,
    );
  if (status === 403)
    return new ConnectorError(
      'The Fly.io token is valid but is not allowed to do this.',
      'NOT_ALLOWED',
      `Create an organization token on the Tokens page (${TOKEN_URL}) so the connector can create its app and computers, and paste it into the Computers connector settings.`,
    );
  if (status === 404 && path.startsWith('/apps?'))
    return new ConnectorError('Fly.io does not know that organization.', 'ORG_NOT_FOUND', 'Check the organization slug in the connector settings (it is "personal" for your own account).');
  if (status === 404) return new ConnectorError('That computer no longer exists on Fly.io.', 'COMPUTER_GONE', 'Call computer_list to see the computers that exist now.');
  if (status === 408) return new ConnectorError('Fly.io took too long to answer.', 'PROVIDER_TIMEOUT', 'Try again; long commands return a job handle to wait on instead of blocking.');
  if (status === 429) return new ConnectorError('Fly.io is rate limiting requests.', 'RATE_LIMITED', 'Wait a minute, then try again.');
  const detail = wrapUntrusted(body.slice(0, 400), 'fly.io:api-error') ?? '';
  if (/insufficient|capacity/i.test(body))
    return new ConnectorError(`Fly.io has no room for this computer in that region right now. ${detail}`, 'NO_CAPACITY', 'Try again in a few minutes, or pick another region in the connector settings.');
  if (/payment|billing|credit card/i.test(body))
    return new ConnectorError(`Fly.io refused because of the account's billing. ${detail}`, 'BILLING', 'Add or check a payment method at https://fly.io/dashboard/personal/billing, then try again.');
  return new ConnectorError(`Fly.io refused the request (HTTP ${status}). ${detail}`, 'PROVIDER_ERROR', 'Try again; if it repeats, check https://status.flyio.net.');
}
