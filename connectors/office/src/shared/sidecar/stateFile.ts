import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  OFFICE_SIDECAR_ERROR_CODES,
  type OfficeSidecarErrorCode,
} from './errorMessages.js';

export interface SidecarState {
  port: number;
  token: string;
  pid: number;
  manifestPath?: string | undefined;
  lastEagerStartErrorCode?: string | undefined;
}

export interface SidecarLastFailure {
  code: OfficeSidecarErrorCode;
  at: number;
}

export interface SidecarLastFailureReadOptions {
  logger?: {
    warn: (details: { err: unknown; path: string }, message: string) => void;
  };
}

export const SIDECAR_STATE_FILE_NAME = 'sidecar-state.json';
export const SIDECAR_LAST_FAILURE_FILE_NAME = 'sidecar-last-failure.json';

export function resolveStateFilePath(stateDirectory = process.env.REBEL_OFFICE_SIDECAR_STATE_DIR): string {
  if (!stateDirectory || stateDirectory.trim().length === 0) {
    throw new Error('REBEL_OFFICE_SIDECAR_STATE_DIR is required.');
  }

  return path.join(stateDirectory, SIDECAR_STATE_FILE_NAME);
}

export function resolveLastFailureFilePath(
  stateDirectory = process.env.REBEL_OFFICE_SIDECAR_STATE_DIR,
): string {
  if (!stateDirectory || stateDirectory.trim().length === 0) {
    throw new Error('REBEL_OFFICE_SIDECAR_STATE_DIR is required.');
  }

  return path.join(stateDirectory, SIDECAR_LAST_FAILURE_FILE_NAME);
}

async function renameAtomically(tmpPath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') {
      throw error;
    }

    try {
      await fs.unlink(targetPath);
    } catch {
      // Best effort: file may not exist.
    }

    await fs.rename(tmpPath, targetPath);
  }
}

export async function atomicWriteFile(targetPath: string, payload: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });

  try {
    await renameAtomically(tmpPath, targetPath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

export async function writeStateFile(
  state: SidecarState,
  stateDirectory = process.env.REBEL_OFFICE_SIDECAR_STATE_DIR,
): Promise<string> {
  const stateFilePath = resolveStateFilePath(stateDirectory);
  await atomicWriteFile(stateFilePath, JSON.stringify(state));
  return stateFilePath;
}

export async function writeLastFailureFile(
  stateDirectory: string | undefined,
  failure: SidecarLastFailure,
): Promise<string> {
  const lastFailureFilePath = resolveLastFailureFilePath(stateDirectory);
  await atomicWriteFile(lastFailureFilePath, JSON.stringify(failure));
  return lastFailureFilePath;
}

export async function readLastFailureFile(
  stateDirectory = process.env.REBEL_OFFICE_SIDECAR_STATE_DIR,
  options: SidecarLastFailureReadOptions = {},
): Promise<SidecarLastFailure | null> {
  const lastFailureFilePath = resolveLastFailureFilePath(stateDirectory);

  try {
    const raw = await fs.readFile(lastFailureFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SidecarLastFailure> | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    if (!OFFICE_SIDECAR_ERROR_CODES.includes(parsed.code as OfficeSidecarErrorCode)) {
      return null;
    }

    if (typeof parsed.at !== 'number' || !Number.isInteger(parsed.at) || parsed.at <= 0) {
      return null;
    }

    return {
      code: parsed.code as OfficeSidecarErrorCode,
      at: parsed.at,
    };
  } catch (err) {
    options.logger?.warn({ err, path: lastFailureFilePath }, 'Failed to read Office sidecar last-failure file');
    return null;
  }
}
