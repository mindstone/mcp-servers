/**
 * What the assistant does on a computer, built once over every provider's exec, upload and download:
 * finding computers by name, setup, commands as jobs (so Stop really ends them), the browser,
 * saved tools and file copies.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConnectorError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import { MAX_FILE_BYTES, libraryFileToRead, writeNewLibraryFile } from './library.js';
import { type ComputerInfo, type ExecResult, type Provider, type ProviderId, NAME_PATTERN, TOOLBOX } from './provider.js';
import { shellQuote } from './providers/gcp.js';

const BOX = '/var/lib/mcp-computer/box.py';
const SETUP_VERSION = '2';

const AGENT_BROWSER_VERSION = '0.33.2';
/** Small enough for every provider's exec request (Fly's is about 16 KB). */
const CHUNK = 6000;
const DEFAULT_WAIT_SEC = 45;

export interface Located {
  provider: Provider;
  computer: ComputerInfo;
}

export interface JobStatus {
  hint?: string;
  computer: string;
  job: string;
  state: 'running' | 'finished' | 'stopped' | 'unknown';
  exit_code: number | null;
  stopped_reason?: string | null;
  output: string;
  next_offset: number;
  more_output: boolean;
  elapsed_sec: number;
}

let boxSource: string | undefined;
async function boxScript(): Promise<string> {
  boxSource ??= await readFile(fileURLToPath(new URL('../box/box.py', import.meta.url)), 'utf8');
  return boxSource;
}

export class Computers {
  /** Computers whose runner was checked against this version of the connector, this session. */
  private checkedRunner = new Set<string>();

  constructor(private readonly providers: Provider[]) {}

  get configured(): Provider[] {
    return this.providers;
  }

  requireAny(): void {
    if (this.providers.length === 0)
      throw new ConnectorError(
        'No cloud account is connected yet.',
        'NOT_CONFIGURED',
        'Add at least one key in the Computers connector settings: a Fly.io API token, an E2B API key or a Google Cloud service-account key. Each computer is created on, and paid for by, that account.',
      );
  }

  pickProvider(id?: ProviderId): Provider {
    this.requireAny();
    if (id) {
      const found = this.providers.find((provider) => provider.id === id);
      if (!found)
        throw new ConnectorError(
          `${id} is not connected.`,
          'PROVIDER_NOT_CONFIGURED',
          `Connected: ${this.providers.map((p) => p.id).join(', ')}. Use one of those, or add the ${id} key in the connector settings.`,
        );
      return found;
    }
    return this.providers[0];
  }

  /** Every computer on every connected account; an account that fails is reported, not hidden. */
  async listAll(): Promise<{ computers: ComputerInfo[]; problems: Array<{ provider: ProviderId; error: string; code: string; resolution: string }> }> {
    // A problem means that account's computers are missing from the list, not that there are none.
    this.requireAny();
    const computers: ComputerInfo[] = [];
    const problems: Array<{ provider: ProviderId; error: string; code: string; resolution: string }> = [];
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          // Names come from the account's own metadata, which anyone with access to it can set:
          // anything that isn't a plain name is shown as the provider's id instead.
          computers.push(...(await provider.list()).map((c) => (NAME_PATTERN.test(c.name) ? c : { ...c, name: c.id.toLowerCase().replace(/[^a-z0-9-]/g, '-') })));
        } catch (error) {
          // Only the error's name: its text could reflect a key.
          if (!(error instanceof ConnectorError)) console.error(`[computers] ${provider.id} list failed (${(error as Error)?.name ?? 'error'})`);
          const known = error instanceof ConnectorError ? error : new ConnectorError(`${provider.label} gave a reply the connector could not read.`, 'PROVIDER_ERROR', 'Try again in a minute.');
          problems.push({ provider: provider.id, error: known.message, code: known.code, resolution: known.resolution });
        }
      }),
    );
    computers.sort((a, b) => a.name.localeCompare(b.name));
    return { computers, problems };
  }

  async find(name: string): Promise<Located> {
    const { computers, problems } = await this.listAll();
    const matches = computers.filter((computer) => computer.name === name);
    if (matches.length === 1) {
      const computer = matches[0];
      return { computer, provider: this.providers.find((p) => p.id === computer.provider)! };
    }
    if (matches.length > 1)
      throw new ConnectorError(`Two computers are called "${name}".`, 'AMBIGUOUS', `Remove or rename one of them; they are on ${matches.map((m) => m.provider).join(' and ')}.`);
    const known = computers.map((c) => c.name);
    const unreachable = problems.length ? ` (${problems.map((p) => p.provider).join(', ')} couldn't be checked: ${problems[0].error})` : '';
    throw new ConnectorError(
      `There is no computer called "${name}"${unreachable}.`,
      'COMPUTER_NOT_FOUND',
      known.length ? `Existing computers: ${known.join(', ')}. Use one of those names, or create it with computer_create.` : 'There are no computers yet; create one with computer_create.',
    );
  }

  /** Finds a computer, makes sure it is running, and brings its runner up to this connector's version. */
  async ready(name: string): Promise<Located> {
    const located = await this.find(name);
    if (located.computer.state !== 'running') {
      await located.provider.start(located.computer);
      located.computer.state = 'running';
    }
    const key = `${located.provider.id}:${located.computer.id}`;
    if (!this.checkedRunner.has(key)) {
      const source = await boxScript();
      const hash = createHash('sha256').update(source).digest('hex');
      const current = await this.root(located, `sha256sum ${BOX} 2>/dev/null | cut -d' ' -f1`);
      if (current.stdout.trim() !== hash) await this.writeViaExec(located, BOX, source);
      this.checkedRunner.add(key);
    }
    return located;
  }

  async create(name: string, providerId?: ProviderId): Promise<{ located: Located; setup: JobStatus }> {
    if (!NAME_PATTERN.test(name))
      throw new ConnectorError(
        `"${name}" can't be used as a computer name.`,
        'BAD_NAME',
        'Use 2–30 lowercase letters, digits and dashes, starting with a letter, such as "research" or "data-cleanup".',
      );
    const provider = this.pickProvider(providerId);
    const { computers } = await this.listAll();
    if (computers.some((computer) => computer.name === name))
      throw new ConnectorError(`A computer called "${name}" already exists.`, 'NAME_TAKEN', 'Use that computer, or pick another name.');
    const computer = await provider.create(name);
    const located = { provider, computer };
    return { located, setup: await this.setup(located) };
  }

  private async root(located: Located, script: string, timeoutSec = 50): Promise<ExecResult> {
    return located.provider.exec(located.computer, script, Math.min(timeoutSec, located.provider.execLimitSec));
  }

  /** Writes a file as root through exec, in chunks small enough for every provider. */
  private async writeViaExec(located: Located, path: string, content: string | Buffer): Promise<void> {
    const encoded = Buffer.from(content).toString('base64');
    const temp = `${path}.b64`;
    await this.mustRun(located, `mkdir -p "$(dirname ${shellQuote(path)})" && : > ${shellQuote(temp)}`);
    for (let start = 0; start < encoded.length; start += CHUNK) {
      await this.mustRun(located, `printf %s '${encoded.slice(start, start + CHUNK)}' >> ${shellQuote(temp)}`);
    }
    await this.mustRun(located, `base64 -d ${shellQuote(temp)} > ${shellQuote(path)} && rm -f ${shellQuote(temp)}`);
  }

  private async mustRun(located: Located, script: string, timeoutSec?: number): Promise<string> {
    const result = await this.root(located, script, timeoutSec);
    if (result.exitCode !== 0) {
      console.error(`[computers] setup step failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
      throw new ConnectorError(
        'A setup step failed on the computer.',
        'SETUP_FAILED',
        'Run computer_setup again; it picks up where it stopped. If it fails twice, remove the computer and create a new one.',
      );
    }
    return result.stdout;
  }

  /**
   * Installs the runner, then the browser and its profile as a job (it takes a few minutes).
   * Safe to repeat: every step checks first.
   */
  async setup(located: Located): Promise<JobStatus> {
    const { provider } = located;
    await this.mustRun(located, 'mkdir -p /var/lib/mcp-computer/jobs && chmod 755 /var/lib/mcp-computer && command -v python3 >/dev/null || (apt-get update -qq && apt-get install -y -qq python3)', 50);
    await this.writeViaExec(located, BOX, await boxScript());
    await provider.afterSetup?.(located.computer, (script) => this.root(located, script));
    const home = provider.home;
    const user = provider.user;
    const script = [
      'set -e',
      `export HOME=${home}`,
      `mkdir -p ${home}/.mcp-computer/bin ${home}/tools`,
      // Root-only machines (Fly) have no sudo: a stand-in keeps "sudo …" commands working everywhere.
      `command -v sudo >/dev/null || { printf '%s\\n' '#!/bin/sh' 'while [ "\${1#-}" != "\$1" ]; do shift; done' 'exec "\$@"' > ${home}/.mcp-computer/bin/sudo && chmod 755 ${home}/.mcp-computer/bin/sudo; }`,
      `export PATH="${home}/.mcp-computer/bin:$PATH"`,
      `if sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${TOOLBOX} >/dev/null; then sudo -n touch /var/lib/mcp-computer/tools-ready; TOOLS=ok; else echo "Some basic tools could not be installed; install them with sudo apt-get when needed."; fi`,
      `grep -q 'mcp-computer/bin' ${home}/.profile 2>/dev/null || printf '%s\\n' 'export PATH="$HOME/.mcp-computer/bin:$PATH"' 'export AGENT_BROWSER_PROFILE="$HOME/.mcp-computer/browser-profile"' >> ${home}/.profile`,
      `if [ ! -x ${home}/.mcp-computer/bin/agent-browser ]; then`,
      '  command -v curl >/dev/null || (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq curl)',
      `  curl -fsSL https://registry.npmjs.org/agent-browser/-/agent-browser-${AGENT_BROWSER_VERSION}.tgz | tar xz -C /tmp package/bin/agent-browser-linux-x64`,
      `  install -m 755 /tmp/package/bin/agent-browser-linux-x64 ${home}/.mcp-computer/bin/agent-browser`,
      'fi',
      `${home}/.mcp-computer/bin/agent-browser install --with-deps >/dev/null 2>&1 || ${home}/.mcp-computer/bin/agent-browser install >/dev/null`,
      `echo ${SETUP_VERSION} > ${home}/.mcp-computer/setup-version`,
      `${home}/.mcp-computer/bin/agent-browser --version >/dev/null && if [ "$TOOLS" = ok ]; then echo "Setup finished: the browser and basic tools are ready."; else echo "Setup finished: the browser is ready, but some basic tools could not be installed."; fi`,
    ].join('\n');
    // As the computer's own user, so the browser and its profile live in the kept home folder.
    return this.startJob(located, script, 1800, home, 'setup');
  }

  async startJob(located: Located, command: string, timeoutSec: number, cwd?: string, prefix = 'job'): Promise<JobStatus> {
    return this.wait(located, await this.begin(located, command, timeoutSec, cwd, prefix), 0, DEFAULT_WAIT_SEC);
  }

  /** Starts a command as a job on the computer and returns its id at once. */
  async begin(located: Located, command: string, timeoutSec: number, cwd?: string, prefix = 'job'): Promise<string> {
    const job = `${prefix}-${randomBytes(5).toString('hex')}`;
    const commandB64 = Buffer.from(command).toString('base64');
    const cwdB64 = Buffer.from(cwd ?? located.provider.home).toString('base64');
    let start: ExecResult;
    if (commandB64.length > CHUNK) {
      const file = `/var/lib/mcp-computer/jobs/${job}.command`;
      await this.writeViaExec(located, file, command);
      start = await this.root(located, `python3 ${BOX} run ${job} ${timeoutSec} ${located.provider.user} ${cwdB64} "$(base64 -w0 ${file})" && rm -f ${file}`);
    } else {
      start = await this.root(located, `python3 ${BOX} run ${job} ${timeoutSec} ${located.provider.user} ${cwdB64} ${commandB64}`);
    }
    if (start.exitCode !== 0) {
      console.error(`[computers] job start failed: ${start.stderr.slice(0, 500)}`);
      throw new ConnectorError('The computer could not start the command.', 'NOT_SET_UP', 'Run computer_setup on this computer, then try again.');
    }
    return job;
  }

  async wait(located: Located, job: string, offset: number, waitSec = DEFAULT_WAIT_SEC): Promise<JobStatus> {
    checkJobId(job);
    const seconds = Math.max(0, Math.min(waitSec, located.provider.execLimitSec - 10));
    const result = await this.root(located, `python3 ${BOX} wait ${job} ${seconds} ${Math.max(0, Math.floor(offset))}`, seconds + 15);
    // The runner lives on the computer, which commands can change: its reply is checked field by field,
    // so nothing but the enveloped output can carry text from the computer to the model.
    let parsed: z.infer<typeof WAIT_REPLY>;
    try {
      parsed = WAIT_REPLY.parse(JSON.parse(result.stdout));
    } catch {
      throw new ConnectorError('The computer gave an answer the connector could not read.', 'BAD_RESPONSE', 'Run computer_setup on this computer, then try again.');
    }
    if (parsed.state === 'unknown')
      throw new ConnectorError(`The computer has no job "${job}".`, 'JOB_NOT_FOUND', 'Jobs are forgotten when a computer restarts; run the command again if it still needs to run.');
    const output = Buffer.from(parsed.output_b64 ?? '', 'base64').toString('utf8');
    return {
      computer: located.computer.name,
      job,
      state: parsed.state,
      exit_code: parsed.exit_code ?? null,
      stopped_reason: parsed.stopped_reason == null ? null : STOP_REASONS.has(parsed.stopped_reason) ? parsed.stopped_reason : 'stopped',
      output: wrapUntrusted(output, 'computers:command-output') ?? '',
      ...hintFor(output),
      next_offset: parsed.next_offset ?? offset,
      more_output: parsed.more_output ?? false,
      elapsed_sec: parsed.elapsed_sec ?? 0,
    };
  }

  async cancel(located: Located, job: string): Promise<JobStatus> {
    checkJobId(job);
    await this.root(located, `python3 ${BOX} cancel ${job}`);
    return this.wait(located, job, 0, 0);
  }

  /**
   * Before a stop: ends every command (a paused E2B computer would otherwise resume them later)
   * and closes the browser so its sign-ins are saved. Returns false if that couldn't be confirmed;
   * the stop still goes ahead, and the result says so.
   */
  async prepareToStop(located: Located): Promise<boolean> {
    try {
      const result = await this.root(located, `python3 ${BOX} end-all && python3 ${BOX} close-browser`, 45);
      if (result.exitCode === 0) return true;
      console.error(`[computers] preparing to stop failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
    } catch (error) {
      console.error(`[computers] preparing to stop failed (${(error as Error)?.name ?? 'error'})`);
    }
    return false;
  }

  async copyIn(located: Located, libraryPath: string | undefined, content: string | undefined, destination: string, replace: boolean): Promise<{ computer: string; path: string; bytes: number }> {
    if ((libraryPath === undefined) === (content === undefined))
      throw new ConnectorError('Give either library_path or content, not both or neither.', 'BAD_ARGUMENTS', 'Use library_path to copy a Library file, or content to write text into a new file.');
    const target = this.absolute(located, destination);
    const data = content !== undefined ? Buffer.from(content, 'utf8') : await readFile((await libraryFileToRead(libraryPath!)).absolute);
    await located.provider.upload(located.computer, target, data, replace ? 'replace' : 'new');
    if (located.provider.user !== 'root') await this.root(located, `chown ${located.provider.user}: ${shellQuote(target)}`);
    return { computer: located.computer.name, path: target, bytes: data.length };
  }

  async copyOut(located: Located, source: string, libraryPath: string): Promise<{ computer: string; library_path: string; bytes: number }> {
    const path = this.absolute(located, source);
    const size = Number((await this.root(located, `stat -c %s ${shellQuote(path)} 2>/dev/null`)).stdout.trim() || NaN);
    if (!Number.isFinite(size))
      throw new ConnectorError(`${path} does not exist on the computer, or its size can't be read.`, 'SOURCE_MISSING', 'Check the path with computer_run (for example `ls -la <folder>`).');
    if (size > MAX_FILE_BYTES)
      throw new ConnectorError(`${path} is larger than 200 MB.`, 'FILE_TOO_LARGE', 'Compress or split it on the computer first (for example with zip or split), then copy the parts.');
    const data = await located.provider.download(located.computer, path);
    const written = await writeNewLibraryFile(libraryPath, data);
    return { computer: located.computer.name, library_path: written, bytes: data.length };
  }

  absolute(located: Located, path: string): string {
    if (!path || path.includes('\0')) throw new ConnectorError('The path is empty.', 'BAD_PATH', 'Give a path on the computer, such as "report.pdf" or "/tmp/data.csv".');
    return path.startsWith('/') ? path : `${located.provider.home}/${path.replace(/^\.\//, '')}`;
  }

  async saveTool(located: Located, name: string, description: string, script: string): Promise<{ computer: string; tool: string; path: string }> {
    if (!NAME_PATTERN.test(name)) throw new ConnectorError(`"${name}" can't be used as a tool name.`, 'BAD_NAME', 'Use lowercase letters, digits and dashes, such as "clean-csv".');
    const folder = `${located.provider.home}/tools`;
    const body = script.startsWith('#!') ? script : `#!/bin/bash\nset -euo pipefail\n${script}`;
    await this.writeViaExec(located, `${folder}/${name}`, body);
    await this.writeViaExec(located, `${folder}/${name}.json`, JSON.stringify({ name, description, saved: new Date().toISOString() }));
    await this.root(located, `chmod 755 ${folder}/${name} && chown -R ${located.provider.user}: ${folder}`);
    return { computer: located.computer.name, tool: name, path: `${folder}/${name}` };
  }

  async tools(located: Located): Promise<Array<{ name: string; description: string }>> {
    const result = await this.root(located, `cat ${located.provider.home}/tools/*.json 2>/dev/null | python3 -c 'import sys,json; print(json.dumps([json.loads(l) for l in sys.stdin.read().replace("}{","}\\n{").splitlines() if l.strip()]))'`);
    try {
      // The tool files can be edited by anything on the computer: only plain names are shown.
      return (JSON.parse(result.stdout || '[]') as Array<{ name: string; description: string }>).filter((tool) => typeof tool.name === 'string' && NAME_PATTERN.test(tool.name)).map((tool) => ({
        name: tool.name,
        description: wrapUntrusted(tool.description, 'computers:saved-tool') ?? '',
      }));
    } catch {
      return [];
    }
  }
}

/** A next step for failures an assistant meets often, read from the command's output. */
function hintFor(output: string): { hint?: string } {
  if (/No space left on device/i.test(output))
    return { hint: 'The computer\'s disk is full, and the failed command may have left a partial file. Find what is using space with `df -h; sudo du -xsh /home/* /var/tmp/* /tmp/* /root 2>/dev/null` (no sort or pipes: they need free space too). Caches are safe to clear: `rm -rf ~/.cache/pip ~/.npm/_cacache; sudo apt-get clean`. Delete anything else only if it is clearly yours or the person agrees, then run the command again.' };
  // The hint never repeats text from the computer: that only reaches the model inside the output's envelope.
  if (/: command not found/.test(output))
    return { hint: 'A program the command needs is not installed (see "command not found" in the output). Install it with `sudo apt-get install -y <package>` (or pip/npm for language tools), then run the command again.' };
  return {};
}

const WAIT_REPLY = z.object({
  state: z.enum(['running', 'finished', 'stopped', 'unknown']),
  exit_code: z.number().int().nullable().optional(),
  stopped_reason: z.string().max(100).nullable().optional(),
  output_b64: z.string().max(200_000).optional(),
  next_offset: z.number().int().min(0).optional(),
  more_output: z.boolean().optional(),
  elapsed_sec: z.number().int().min(0).optional(),
});

const STOP_REASONS = new Set(['cancelled', 'lease', 'timeout', 'restart', 'computer stopped']);

function checkJobId(job: string): void {
  if (!/^[a-z]+-[0-9a-f]{10}$/.test(job)) throw new ConnectorError(`"${job}" is not a job id.`, 'BAD_JOB', 'Use the job value a previous computer_run returned.');
}

export function quoteArgs(args: string[]): string {
  return args.map(shellQuote).join(' ');
}
