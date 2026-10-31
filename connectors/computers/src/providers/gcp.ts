/**
 * Google Cloud: each computer is a Compute Engine instance (Debian 12) on a network the connector
 * owns (`mcp-computers`, created on first use with one rule: SSH in, for instances tagged
 * `mcp-computer`), so it never changes the person's other networks.
 *
 * Credentials are a service-account JSON key. The connector signs its own short-lived token, and
 * reaches each instance over SSH with a key it generates per session and publishes in the
 * instance's metadata with an expiry, so no private key is ever stored.
 */
import { createSign } from 'node:crypto';
import ssh2 from 'ssh2';
import type { Client as SshClient, SFTPWrapper } from 'ssh2';

const { Client, utils: sshUtils } = ssh2;
import { ConnectorError } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { type ComputerInfo, type ComputerState, type ExecResult, type Provider, extraLabels, sleep } from '../provider.js';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const NETWORK = 'mcp-computers';
const TAG = 'mcp-computer';
const USER = 'computer';
const KEY_HELP = 'https://console.cloud.google.com/iam-admin/serviceaccounts';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface Instance {
  id: string;
  name: string;
  status: string;
  zone: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  metadata?: { fingerprint: string; items?: Array<{ key: string; value: string }> };
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw);
  } catch {
    throw new ConnectorError(
      'The Google Cloud key is not valid JSON.',
      'BAD_KEY',
      `Paste the whole JSON key file of a service account (IAM → Service accounts → Keys → Add key → JSON at ${KEY_HELP}), from the opening { to the closing }.`,
    );
  }
  if (!key.client_email || !key.private_key || !key.project_id)
    throw new ConnectorError(
      'That JSON is not a service-account key.',
      'BAD_KEY',
      `Use a service account's JSON key (it has client_email, private_key and project_id), from ${KEY_HELP}.`,
    );
  return key as ServiceAccountKey;
}

export class GcpProvider implements Provider {
  readonly id = 'gcp' as const;
  readonly label = 'Google Cloud';
  readonly user = USER;
  readonly home = `/home/${USER}`;
  readonly execLimitSec = 600;
  readonly idleShutdown = 'poweroff';
  private token: { value: string; expires: number } | undefined;
  private readonly sshKey = sshUtils.generateKeyPairSync('ed25519');
  private readonly project: string;

  constructor(
    private readonly key: ServiceAccountKey,
    project: string | undefined,
    private readonly zone: string,
    private readonly machineType: string,
  ) {
    this.project = project || key.project_id;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({
      iss: this.key.client_email,
      scope: 'https://www.googleapis.com/auth/compute',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    let signature: string;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(this.key.private_key).toString('base64url');
    } catch {
      throw new ConnectorError('The Google Cloud key\'s private_key could not be read.', 'BAD_KEY', `Create a fresh JSON key for the service account at ${KEY_HELP} and paste the whole file.`);
    }
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new ConnectorError('Google Cloud could not be reached.', 'PROVIDER_UNREACHABLE', 'Check the internet connection and try again in a minute.');
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token)
      throw new ConnectorError(
        'Google Cloud did not accept the service-account key.',
        'AUTH_FAILED',
        `The key may have been deleted or disabled. Create a new JSON key for ${this.key.client_email} at ${KEY_HELP} and paste it into the connector.`,
      );
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('https://') ? path : `${COMPUTE}/projects/${this.project}${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    }).catch(() => {
      throw new ConnectorError('Google Cloud could not be reached.', 'PROVIDER_UNREACHABLE', 'Check the internet connection and try again in a minute.');
    });
    const text = await response.text();
    if (response.ok) {
      try {
        return (text ? JSON.parse(text) : {}) as T;
      } catch {
        throw new ConnectorError('Google Cloud gave a reply the connector could not read.', 'PROVIDER_ERROR', 'Try again in a minute.');
      }
    }
    console.error(`[computers] Google Cloud ${method} ${url.replace(COMPUTE, '')} -> HTTP ${response.status}`);
    throw this.error(response.status, text);
  }

  private error(status: number, rawBody: string): ConnectorError {
    // Every error path comes through here, so the account's own token is removed in one place.
    const body = this.token?.value ? rawBody.split(this.token.value).join('[key removed]') : rawBody;
    const reason = (() => {
      try {
        return (JSON.parse(body).error?.message as string) ?? '';
      } catch {
        return '';
      }
    })();
    if (status === 401) return new ConnectorError('Google Cloud did not accept the key.', 'AUTH_FAILED', `Create a new JSON key at ${KEY_HELP} and paste it into the connector.`);
    if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(reason))
      return new ConnectorError(
        `The Compute Engine API is off in the project "${this.project}".`,
        'API_DISABLED',
        `Turn it on at https://console.cloud.google.com/apis/library/compute.googleapis.com?project=${this.project}, wait a minute, then try again.`,
      );
    if (status === 403)
      return new ConnectorError(
        `The service account ${this.key.client_email} is not allowed to do this in "${this.project}".`,
        'NOT_ALLOWED',
        `Give it the "Compute Admin" role on that project at https://console.cloud.google.com/iam-admin/iam?project=${this.project}.`,
      );
    if (status === 404 && /^The resource 'projects\/[^/']+' was not found/.test(reason))
      return new ConnectorError(`Google Cloud has no project "${this.project}" for this key.`, 'PROJECT_NOT_FOUND', 'Check the project id in the connector settings (leave it empty to use the key\'s own project).');
    if (status === 404) return new ConnectorError('That computer no longer exists on Google Cloud.', 'COMPUTER_GONE', 'Call computer_list to see the computers that exist now.');
    const detail = wrapUntrusted(reason.slice(0, 400), 'gcp:api-error') ?? '';
    if (/quota/i.test(reason)) return new ConnectorError(`Google Cloud quota is used up. ${detail}`, 'QUOTA', `Free some resources or ask for more quota at https://console.cloud.google.com/iam-admin/quotas?project=${this.project}.`);
    if (/billing/i.test(reason)) return new ConnectorError(`Billing is not set up for "${this.project}". ${detail}`, 'BILLING', `Link a billing account at https://console.cloud.google.com/billing/linkedaccount?project=${this.project}.`);
    if (/ZONE_RESOURCE_POOL_EXHAUSTED|does not have enough resources/i.test(reason))
      return new ConnectorError(`That zone has no room right now. ${detail}`, 'NO_CAPACITY', 'Try again later, or choose another zone in the connector settings.');
    return new ConnectorError(`Google Cloud refused the request (HTTP ${status}). ${detail}`, 'PROVIDER_ERROR', 'Try again; if it repeats, check https://status.cloud.google.com.');
  }

  private async waitOperation(operation: { selfLink: string; status: string; error?: { errors?: Array<{ message: string }> } }): Promise<void> {
    let current = operation;
    for (let attempt = 0; current.status !== 'DONE' && attempt < 60; attempt++) {
      current = await this.api('POST', `${current.selfLink}/wait`);
    }
    if (current.status !== 'DONE') throw new ConnectorError('Google Cloud is taking unusually long.', 'PROVIDER_TIMEOUT', 'Wait a minute, then call computer_list to see where it got to.');
    const message = current.error?.errors?.map((e) => e.message).join('; ');
    if (message) throw this.error(400, JSON.stringify({ error: { message } }));
  }

  async check(): Promise<string> {
    await this.api('GET', `/zones/${this.zone}`);
    const computers = await this.list();
    return `Google Cloud: the key works for the project "${this.project}" (${this.key.client_email}); computers go in ${this.zone} (${computers.length} so far).`;
  }

  async list(): Promise<ComputerInfo[]> {
    const instances: Instance[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.api<{ items?: Instance[]; nextPageToken?: string }>(
        'GET',
        `/zones/${this.zone}/instances?filter=${encodeURIComponent('labels.mcp-computer = "1"')}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      instances.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return instances.map((instance) => this.info(instance));
  }

  private info(instance: Instance): ComputerInfo {
    return { provider: 'gcp', id: instance.name, name: instance.labels?.['mcp-computer-name'] ?? instance.name, state: gcpState(instance.status), region: this.zone, createdAt: instance.creationTimestamp };
  }

  private async ensureNetwork(): Promise<void> {
    try {
      await this.api('GET', `/global/networks/${NETWORK}`);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'COMPUTER_GONE') throw error;
      await this.waitOperation(await this.api('POST', '/global/networks', { name: NETWORK, autoCreateSubnetworks: true, description: 'Computers made by the Computers connector only.' }));
    }
    try {
      await this.api('GET', `/global/firewalls/${NETWORK}-ssh`);
    } catch (error) {
      if (!(error instanceof ConnectorError) || error.code !== 'COMPUTER_GONE') throw error;
      await this.waitOperation(
        await this.api('POST', '/global/firewalls', {
          name: `${NETWORK}-ssh`,
          network: `projects/${this.project}/global/networks/${NETWORK}`,
          description: 'SSH to the Computers connector\'s computers (key-only; keys are short-lived).',
          targetTags: [TAG],
          sourceRanges: ['0.0.0.0/0'],
          allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
        }),
      );
    }
  }

  async create(name: string): Promise<ComputerInfo> {
    await this.ensureNetwork();
    const instanceName = `computer-${name}`;
    await this.waitOperation(
      await this.api('POST', `/zones/${this.zone}/instances`, {
        name: instanceName,
        machineType: `zones/${this.zone}/machineTypes/${this.machineType}`,
        labels: { 'mcp-computer': '1', 'mcp-computer-name': name, ...extraLabels() },
        tags: { items: [TAG] },
        disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: 'projects/debian-cloud/global/images/family/debian-12', diskSizeGb: '20', labels: extraLabels() } }],
        networkInterfaces: [{ network: `projects/${this.project}/global/networks/${NETWORK}`, accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
        metadata: { items: [{ key: 'ssh-keys', value: this.keyLine() }, { key: 'enable-guest-attributes', value: 'TRUE' }] },
      }),
    );
    const computer: ComputerInfo = { provider: 'gcp', id: instanceName, name, state: 'running', region: this.zone };
    await this.waitForSsh(computer);
    return computer;
  }

  private keyLine(): string {
    // Google's guest agent format; milliseconds make the API fail with an internal error.
    const expireOn = new Date(Date.now() + 12 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+0000');
    const publicKey = this.sshKey.public.trim().split(' ').slice(0, 2).join(' ');
    return `${USER}:${publicKey} google-ssh {"userName":"${USER}","expireOn":"${expireOn}"}`;
  }

  /** Publishes this session's key (keeping other unexpired keys) unless it's already there. */
  private async ensureKey(instance: Instance): Promise<void> {
    const publicKey = this.sshKey.public.trim().split(' ')[1];
    const items = instance.metadata?.items ?? [];
    const keys = items.find((item) => item.key === 'ssh-keys')?.value ?? '';
    const now = Date.now();
    const expiry = (line: string) => Date.parse(/"expireOn":"([^"]+)"/.exec(line)?.[1] ?? '');
    const ours = keys.split('\n').find((line) => line.includes(publicKey));
    if (ours && expiry(ours) > now + 3600_000) return;
    const kept = keys.split('\n').filter((line) => line.trim() && !line.includes(publicKey) && !(expiry(line) <= now));
    const value = [...kept, this.keyLine()].join('\n');
    await this.waitOperation(
      await this.api('POST', `/zones/${this.zone}/instances/${instance.name}/setMetadata`, {
        fingerprint: instance.metadata?.fingerprint,
        items: [...items.filter((item) => item.key !== 'ssh-keys'), { key: 'ssh-keys', value }],
      }),
    );
  }

  private async address(computer: ComputerInfo): Promise<{ ip: string; hostKeys: Set<string> }> {
    const instance = await this.api<Instance>('GET', `/zones/${this.zone}/instances/${computer.id}`);
    await this.ensureKey(instance);
    const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
    if (!ip) throw new ConnectorError('The computer has no public address yet.', 'NOT_READY', 'Wait a minute, then try again.');
    return { ip, hostKeys: await this.hostKeys(computer) };
  }

  /** The SSH host keys the instance's guest agent publishes, so a connection can't be intercepted. */
  private async hostKeys(computer: ComputerInfo): Promise<Set<string>> {
    const result = await this.api<{ queryValue?: { items?: Array<{ key: string; value: string }> } }>(
      'GET',
      `/zones/${this.zone}/instances/${computer.id}/getGuestAttributes?queryPath=hostkeys%2F`,
    ).catch(() => ({ queryValue: undefined }));
    const keys = new Set((result.queryValue?.items ?? []).map((item) => item.value.trim().split(' ').pop()!));
    if (keys.size === 0) throw new ConnectorError('The computer has not published its identity yet.', 'NOT_READY', 'Wait a minute, then try again.');
    return keys;
  }

  private connections = new Map<string, Promise<SshClient>>();

  private connect(computer: ComputerInfo): Promise<SshClient> {
    const existing = this.connections.get(computer.id);
    if (existing) return existing;
    const pending = (async () => {
      const { ip, hostKeys } = await this.address(computer);
      return new Promise<SshClient>((resolve, reject) => {
        const client = new Client();
        client
          .on('ready', () => resolve(client))
          .on('error', (error) => reject(error))
          .on('close', () => this.connections.delete(computer.id))
          .connect({
            host: ip,
            port: 22,
            username: USER,
            privateKey: this.sshKey.private,
            readyTimeout: 20_000,
            keepaliveInterval: 15_000,
            hostVerifier: (key: Buffer) => hostKeys.has(key.toString('base64')),
          });
      });
    })();
    this.connections.set(computer.id, pending);
    pending.catch(() => this.connections.delete(computer.id));
    return pending;
  }

  private async waitForSsh(computer: ComputerInfo): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await this.connect(computer);
        return;
      } catch {
        // The guest agent installs the key a few seconds after boot.
        await sleep(4000);
      }
    }
    throw new ConnectorError('The computer started but is not answering yet.', 'NOT_READY', 'Wait a minute, then try the same request again.');
  }

  async start(computer: ComputerInfo): Promise<void> {
    const instance = await this.api<Instance>('GET', `/zones/${this.zone}/instances/${computer.id}`);
    if (instance.status === 'STOPPING') {
      for (let attempt = 0; attempt < 30 && (await this.api<Instance>('GET', `/zones/${this.zone}/instances/${computer.id}`)).status === 'STOPPING'; attempt++) await sleep(3000);
    }
    if (instance.status !== 'RUNNING') await this.waitOperation(await this.api('POST', `/zones/${this.zone}/instances/${computer.id}/start`));
    await this.waitForSsh(computer);
  }

  async stop(computer: ComputerInfo): Promise<void> {
    (await this.connections.get(computer.id)?.catch(() => undefined))?.end();
    await this.waitOperation(await this.api('POST', `/zones/${this.zone}/instances/${computer.id}/stop`));
  }

  async remove(computer: ComputerInfo): Promise<void> {
    (await this.connections.get(computer.id)?.catch(() => undefined))?.end();
    await this.waitOperation(await this.api('DELETE', `/zones/${this.zone}/instances/${computer.id}`));
  }

  async exec(computer: ComputerInfo, script: string, timeoutSec: number): Promise<ExecResult> {
    const client = await this.connect(computer);
    return new Promise((resolve, reject) => {
      client.exec('sudo -n bash -s', (error, stream) => {
        if (error) return reject(sshFailed());
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close();
          reject(new ConnectorError('The computer took too long to answer.', 'PROVIDER_TIMEOUT', 'Try again; long commands return a job handle to wait on instead.'));
        }, timeoutSec * 1000);
        stream.on('data', (data: Buffer) => (stdout += data.toString()));
        stream.stderr.on('data', (data: Buffer) => (stderr += data.toString()));
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? 1, stdout, stderr });
        });
        stream.end(script);
      });
    });
  }

  private async sftp(computer: ComputerInfo) {
    const client = await this.connect(computer);
    return new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, sftp) => (error ? reject(sshFailed()) : resolve(sftp))));
  }

  async upload(computer: ComputerInfo, path: string, data: Buffer, mode: 'new' | 'replace'): Promise<void> {
    // SFTP writes as the computer's user; a root-owned destination goes through a temp file and sudo.
    const sftp = await this.sftp(computer);
    const temp = `/tmp/computer-upload-${Date.now()}`;
    await new Promise<void>((resolve, reject) => sftp.writeFile(temp, data, (error) => (error ? reject(sshFailed()) : resolve())));
    sftp.end();
    const flag = mode === 'new' ? '-n' : '-f';
    const quoted = shellQuote(path);
    const result = await this.exec(
      computer,
      `${mode === 'new' ? `[ -e ${quoted} ] && { rm -f ${temp}; exit 17; }; ` : ''}mkdir -p "$(dirname ${quoted})" && mv ${flag} ${temp} ${quoted} && chown ${USER}: ${quoted}`,
      60,
    );
    if (result.exitCode === 17) throw new ConnectorError(`${path} already exists on the computer.`, 'DESTINATION_EXISTS', 'Choose another destination, or pass replace: true to overwrite it.');
    if (result.exitCode !== 0) throw new ConnectorError(`The computer could not save ${path}.`, 'TRANSFER_FAILED', 'Check the destination folder is writable, then try again.');
  }

  async download(computer: ComputerInfo, path: string): Promise<Buffer> {
    const exists = await this.exec(computer, `[ -f ${shellQuote(path)} ] && [ -r ${shellQuote(path)} ]`, 30);
    if (exists.exitCode !== 0) throw new ConnectorError(`${path} does not exist on the computer, or is not a file.`, 'SOURCE_MISSING', 'Check the path with computer_run (for example `ls -la <folder>`).');
    const sftp = await this.sftp(computer);
    try {
      return await new Promise<Buffer>((resolve, reject) => sftp.readFile(path, (error, data) => (error ? reject(sshFailed()) : resolve(data))));
    } finally {
      sftp.end();
    }
  }

  async afterSetup(_computer: ComputerInfo, run: (script: string) => Promise<ExecResult>): Promise<void> {
    const shutdown = Buffer.from(this.idleShutdown).toString('base64');
    await run(
      `cat > /etc/systemd/system/mcp-computer-idle.service <<'UNIT'\n[Unit]\nDescription=Stop this computer when idle\n[Service]\nExecStart=/usr/bin/python3 /var/lib/mcp-computer/box.py idle 15 ${shutdown}\nRestart=always\n[Install]\nWantedBy=multi-user.target\nUNIT\n` +
        'systemctl daemon-reload && systemctl enable --now mcp-computer-idle.service',
    );
  }
}

function sshFailed(): ConnectorError {
  return new ConnectorError('The connection to the computer dropped.', 'CONNECTION_LOST', 'Try again; the connector reconnects by itself.');
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gcpState(status: string): ComputerState {
  if (status === 'RUNNING') return 'running';
  if (status === 'TERMINATED' || status === 'STOPPED' || status === 'SUSPENDED') return 'stopped';
  if (status === 'PROVISIONING' || status === 'STAGING') return 'starting';
  if (status === 'STOPPING' || status === 'SUSPENDING') return 'stopping';
  return 'unknown';
}
