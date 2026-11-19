/**
 * E2B: each computer is a sandbox that pauses itself after 15 idle minutes and keeps its files
 * (and memory) while paused, with no time limit. Commands and files use E2B's own SDK.
 */
import { randomBytes } from 'node:crypto';
import { CommandExitError, Sandbox, Template, type SandboxInfo } from 'e2b';
import { ConnectorError } from '../types.js';
import { CommandOutput, fileLimit, keepingLimitErrors, limitErrorSoFar, readCapped } from '../limits.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { type ComputerInfo, type ExecResult, type Provider, extraLabels } from '../provider.js';

const IDLE_MS = 15 * 60_000;
/** E2B's default sandbox has about 0.5 GB of memory, too little for Chrome; this template has 2 GB. */
const TEMPLATE = 'mcp-computer';
const TEMPLATE_CPUS = 2;
const TEMPLATE_MEMORY_MB = 2048;
const KEY_URL = 'https://e2b.dev/dashboard?tab=keys';

export class E2bProvider implements Provider {
  readonly id = 'e2b' as const;
  readonly label = 'E2B';
  readonly user = 'user';
  readonly home = '/home/user';
  readonly execLimitSec = 600;
  /** E2B pauses an idle sandbox itself; each call pushes that back 15 minutes. */
  readonly idleShutdown = null;
  private sandboxes = new Map<string, Sandbox>();
  /** Removed here; E2B's list can show them for a while after. */
  private removed = new Map<string, number>();
  private lastKeptAwake = new Map<string, number>();

  constructor(private readonly apiKey: string) {}

  private get opts() {
    return { apiKey: this.apiKey, requestTimeoutMs: 60_000 };
  }

  async check(): Promise<string> {
    const computers = await this.list();
    return `E2B: the API key works (${computers.length} computer${computers.length === 1 ? '' : 's'} so far).`;
  }

  async list(): Promise<ComputerInfo[]> {
    const found: SandboxInfo[] = [];
    try {
      const pages = Sandbox.list({ ...this.opts, query: { metadata: { 'mcp-computer': '1' }, state: ['running', 'paused'] } });
      while (pages.hasNext) found.push(...(await pages.nextItems()));
    } catch (error) {
      throw e2bError(error, this.apiKey);
    }
    const now = Date.now();
    for (const [id, at] of this.removed) if (now - at > 10 * 60_000) this.removed.delete(id);
    return found.filter((info) => !this.removed.has(info.sandboxId)).map((info) => ({
      provider: 'e2b' as const,
      id: info.sandboxId,
      name: info.metadata['mcp-computer-name'] ?? info.sandboxId,
      state: info.state === 'running' ? ('running' as const) : ('stopped' as const),
      createdAt: info.startedAt.toISOString(),
    }));
  }

  /** Builds the computer template in the person's E2B account the first time (about a minute). */
  private async ensureTemplate(): Promise<void> {
    if (await Template.exists(TEMPLATE, this.opts)) return;
    await Template.build(Template().fromBaseImage(), TEMPLATE, { ...this.opts, cpuCount: TEMPLATE_CPUS, memoryMB: TEMPLATE_MEMORY_MB });
  }

  async create(name: string): Promise<ComputerInfo> {
    try {
      await this.ensureTemplate();
      const sandbox = await Sandbox.create(TEMPLATE, {
        ...this.opts,
        metadata: { 'mcp-computer': '1', 'mcp-computer-name': name, ...extraLabels() },
        timeoutMs: IDLE_MS,
        lifecycle: { onTimeout: 'pause' },
      });
      this.sandboxes.set(sandbox.sandboxId, sandbox);
      return { provider: 'e2b', id: sandbox.sandboxId, name, state: 'running' };
    } catch (error) {
      throw e2bError(error, this.apiKey);
    }
  }

  private async sandbox(computer: ComputerInfo): Promise<Sandbox> {
    try {
      // connect resumes a paused sandbox and resets its idle timer.
      const sandbox = await Sandbox.connect(computer.id, { ...this.opts, timeoutMs: IDLE_MS });
      this.sandboxes.set(computer.id, sandbox);
      this.lastKeptAwake.set(computer.id, Date.now());
      return sandbox;
    } catch (error) {
      throw e2bError(error, this.apiKey);
    }
  }

  async start(computer: ComputerInfo): Promise<void> {
    await this.sandbox(computer);
  }

  async stop(computer: ComputerInfo): Promise<void> {
    try {
      await Sandbox.pause(computer.id, this.opts);
    } catch (error) {
      throw e2bError(error, this.apiKey);
    }
  }

  async remove(computer: ComputerInfo): Promise<void> {
    try {
      await Sandbox.kill(computer.id, this.opts);
    } catch (error) {
      throw e2bError(error, this.apiKey);
    }
    this.removed.set(computer.id, Date.now());
    this.sandboxes.delete(computer.id);
  }

  /** Each use pushes the idle pause 15 minutes out (at most once a minute), so a computer in use never pauses. */
  private async keepAwake(computer: ComputerInfo, sandbox: Sandbox): Promise<void> {
    if (Date.now() - (this.lastKeptAwake.get(computer.id) ?? 0) < 60_000) return;
    await sandbox.setTimeout(IDLE_MS);
    this.lastKeptAwake.set(computer.id, Date.now());
  }

  async exec(computer: ComputerInfo, script: string, timeoutSec: number): Promise<ExecResult> {
    const sandbox = this.sandboxes.get(computer.id) ?? (await this.sandbox(computer));
    // A file per call: tool calls can run at the same time on one computer.
    const file = `/tmp/computer-exec-${randomBytes(6).toString('hex')}.sh`;
    // The SDK keeps no output of its own here; past either limit (the output callbacks' or the
    // transport's) the stream is dropped locally, and the command is killed as well since dropping
    // the stream doesn't end it.
    const stream = new AbortController();
    const output = new CommandOutput((tooLarge) => stream.abort(tooLarge));
    let handle: { kill(): Promise<unknown> } | undefined;
    return keepingLimitErrors(async () => {
      try {
        await this.keepAwake(computer, sandbox);
        await sandbox.files.write(file, script, { user: 'root' });
        const started = await sandbox.commands.run(`bash ${file}; status=$?; rm -f ${file}; exit $status`, {
          user: 'root',
          timeoutMs: timeoutSec * 1000,
          background: true,
          retainOutput: false,
          onStdout: (data) => output.add('stdout', data),
          onStderr: (data) => output.add('stderr', data),
          signal: stream.signal,
        });
        handle = started;
        const result = await started.wait();
        if (output.error) throw output.error;
        return { exitCode: result.exitCode, stdout: output.stdout, stderr: output.stderr };
      } catch (error) {
        const tooLarge = output.error ?? limitErrorSoFar();
        if (tooLarge) {
          cleanUp(sandbox, handle, file);
          throw tooLarge;
        }
        // The SDK throws on a non-zero exit; that is a result, not a failure.
        if (error instanceof CommandExitError) return { exitCode: error.exitCode, stdout: output.stdout, stderr: output.stderr };
        throw e2bError(error, this.apiKey);
      }
    });
  }

  async upload(computer: ComputerInfo, path: string, data: Buffer, mode: 'new' | 'replace'): Promise<void> {
    return keepingLimitErrors(() => this.uploadOnce(computer, path, data, mode));
  }

  private async uploadOnce(computer: ComputerInfo, path: string, data: Buffer, mode: 'new' | 'replace'): Promise<void> {
    const sandbox = this.sandboxes.get(computer.id) ?? (await this.sandbox(computer));
    const exists = mode === 'new' ? await sandbox.files.exists(path, { user: 'root' }).catch((error: unknown) => { throw e2bError(error, this.apiKey); }) : false;
    if (exists)
      throw new ConnectorError(`${path} already exists on the computer.`, 'DESTINATION_EXISTS', 'Choose another destination, or pass replace: true to overwrite it.');
    try {
      const bytes = new Uint8Array(data);
      await sandbox.files.write(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { user: this.user });
    } catch (error) {
      throw new ConnectorError(`The computer could not save ${path}.`, 'TRANSFER_FAILED', 'Check the destination folder is writable, then try again.');
    }
  }

  async download(computer: ComputerInfo, path: string): Promise<Buffer> {
    const sandbox = this.sandboxes.get(computer.id) ?? (await this.sandbox(computer));
    return keepingLimitErrors(async () => {
      try {
        return await readCapped(await sandbox.files.read(path, { format: 'stream', user: 'root' }), fileLimit(path));
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError(`${path} does not exist on the computer, or can't be read.`, 'SOURCE_MISSING', 'Check the path with computer_run (for example `ls -la <folder>`).');
      }
    });
  }
}

/**
 * Best-effort, off the critical path: kills a command whose reply was refused, then removes its
 * script, since a killed wrapper never reaches its own `rm`. Neither step is awaited by the caller.
 */
function cleanUp(sandbox: Sandbox, handle: { kill(): Promise<unknown> } | undefined, file: string): void {
  void (handle ? handle.kill() : Promise.resolve())
    .catch(() => undefined)
    .then(() => sandbox.commands.run(`rm -f ${file}`, { user: 'root', timeoutMs: 15_000, requestTimeoutMs: 15_000, retainOutput: false }))
    .catch(() => undefined);
}

function e2bError(error: unknown, apiKey: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = (error as { name?: string })?.name ?? '';
  const raw = error instanceof Error ? error.message : String(error);
  const message = apiKey ? raw.split(apiKey).join('[key removed]') : raw;
  if (name === 'AuthenticationError' || /401|unauthori[sz]ed|invalid api key/i.test(message))
    return new ConnectorError('E2B did not accept the API key.', 'AUTH_FAILED', `Copy a key from ${KEY_URL}, paste it into the Computers connector's E2B API key field, and try again.`);
  if (name === 'NotFoundError' || name === 'SandboxNotFoundError' || /not found/i.test(message))
    return new ConnectorError('That computer no longer exists on E2B.', 'COMPUTER_GONE', 'Call computer_list to see the computers that exist now.');
  if (name === 'RateLimitError' || /429|rate limit|concurren/i.test(message))
    return new ConnectorError('E2B is limiting requests or running computers for this plan.', 'RATE_LIMITED', 'Stop a computer you are not using (computer_stop), or wait a minute and try again.');
  if (/billing|credit|payment|quota/i.test(message))
    return new ConnectorError(`E2B refused because of the account's plan or credits. ${wrapUntrusted(message.slice(0, 300), 'e2b:api-error') ?? ''}`, 'BILLING', 'Check credits and the plan at https://e2b.dev/dashboard, then try again.');
  return new ConnectorError(`E2B refused the request. ${wrapUntrusted(message.slice(0, 300), 'e2b:api-error') ?? ''}`, 'PROVIDER_ERROR', 'Try again; if it repeats, check https://status.e2b.dev.');
}
