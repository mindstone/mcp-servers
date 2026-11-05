/**
 * One interface for every place a computer can live. A provider only does lifecycle and three
 * transport primitives (exec, upload, download); everything a person or the assistant does on a computer
 * (jobs, Stop, the browser, saved tools, setup) is built once on top of those, in computers.ts.
 */

export type ProviderId = 'fly' | 'e2b' | 'gcp';

export type ComputerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown';

export interface ComputerInfo {
  provider: ProviderId;
  /** The provider's own id (machine, sandbox or instance). */
  id: string;
  /** The person's name for it: lowercase letters, digits and dashes. */
  name: string;
  state: ComputerState;
  region?: string;
  createdAt?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Provider {
  readonly id: ProviderId;
  /** How a person names it: "Fly.io", "E2B", "Google Cloud". */
  readonly label: string;
  /** The user commands run as, and their home folder (kept between days). */
  readonly user: string;
  readonly home: string;
  /** The longest one exec may block, in seconds; job waits stay well inside it. */
  readonly execLimitSec: number;
  /** How the computer turns itself off when idle: a shell command, or 'exit' to end the main process. */
  readonly idleShutdown: string | null;

  /** Checks the credentials with one cheap call; returns a sentence saying what they reach. */
  check(): Promise<string>;
  list(): Promise<ComputerInfo[]>;
  create(name: string): Promise<ComputerInfo>;
  /** Starts or resumes it and returns once exec works. */
  start(computer: ComputerInfo): Promise<void>;
  stop(computer: ComputerInfo): Promise<void>;
  remove(computer: ComputerInfo): Promise<void>;
  /** Runs a bash script as root. Small scripts only on some providers: see computers.ts. */
  exec(computer: ComputerInfo, script: string, timeoutSec: number): Promise<ExecResult>;
  upload(computer: ComputerInfo, path: string, data: Buffer, mode: 'new' | 'replace'): Promise<void>;
  download(computer: ComputerInfo, path: string): Promise<Buffer>;
  /** Provider-specific steps after the shared setup (boot hooks, file service). */
  afterSetup?(computer: ComputerInfo, run: (script: string) => Promise<ExecResult>): Promise<void>;
}

/** Everyday tools every computer gets, so common jobs don't start with an install. */
export const TOOLBOX = 'git curl ca-certificates jq zip unzip file iputils-ping poppler-utils python3-pip python3-venv python3-matplotlib';

/** Computer names travel in provider resource names, labels and metadata, so they stay plain. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,28}[a-z0-9]$/;

/** Labels the person asked to put on everything the connector creates (COMPUTERS_LABELS="k=v,k=v"). */
export function extraLabels(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of (env.COMPUTERS_LABELS ?? '').split(',')) {
    const [key, value] = pair.split('=').map((part) => part?.trim());
    if (key && value && /^[a-z][a-z0-9_-]{0,62}$/.test(key) && /^[a-z0-9_-]{0,63}$/.test(value)) labels[key] = value;
  }
  return labels;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
