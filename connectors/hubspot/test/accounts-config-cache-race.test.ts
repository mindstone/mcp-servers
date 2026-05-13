import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAccountManagerForTests,
  getAccountManager,
  type StoredAccountRecord,
} from '../src/modules/accounts/manager.js';
import logger from '../src/utils/logger.js';

type StatsResult = Awaited<ReturnType<typeof fs.stat>>;

function createConfigDir(prefix: string): string {
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  return configDir;
}

function makeAccountsJson(email: string, hubId: number): string {
  return JSON.stringify({ accounts: [{ email, hubId }] });
}

function makeStats(mtimeMs: number, size: number): StatsResult {
  return { mtimeMs, size } as StatsResult;
}

async function readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }> {
  const manager = getAccountManager() as unknown as {
    readAccountsConfig(): Promise<{ accounts: StoredAccountRecord[] }>;
  };
  return manager.readAccountsConfig();
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
});

describe('accounts.json cache race hardening', () => {
  it('retries torn reads and serves the latest snapshot to subsequent calls', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-race-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const oldSnapshot = makeAccountsJson('old@example.com', 1);
    const newSnapshot = makeAccountsJson('new@example.com', 2);

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(1_000, oldSnapshot.length))
      .mockResolvedValueOnce(makeStats(1_001, newSnapshot.length))
      .mockResolvedValueOnce(makeStats(1_001, newSnapshot.length))
      .mockResolvedValueOnce(makeStats(1_001, newSnapshot.length))
      .mockResolvedValueOnce(makeStats(1_001, newSnapshot.length));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce(oldSnapshot)
      .mockResolvedValueOnce(newSnapshot);

    const firstRead = await readAccountsConfig();
    expect(firstRead.accounts).toEqual([
      expect.objectContaining({ email: 'new@example.com', hubId: 2 }),
    ]);

    const secondRead = await readAccountsConfig();
    expect(secondRead.accounts).toEqual([
      expect.objectContaining({ email: 'new@example.com', hubId: 2 }),
    ]);

    expect(readFileSpy).toHaveBeenCalledTimes(2);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('detects same-second writes via size changes and re-reads once', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-size-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const oldSnapshot = makeAccountsJson('short@example.com', 9);
    const newSnapshot = makeAccountsJson('longer-email-address@example.com', 99);

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(2_000, oldSnapshot.length))
      .mockResolvedValueOnce(makeStats(2_000, newSnapshot.length))
      .mockResolvedValueOnce(makeStats(2_000, newSnapshot.length))
      .mockResolvedValueOnce(makeStats(2_000, newSnapshot.length));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce(oldSnapshot)
      .mockResolvedValueOnce(newSnapshot);

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([
      expect.objectContaining({ email: 'longer-email-address@example.com', hubId: 99 }),
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('fails closed after two torn reads and retries on the next call', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-fail-closed-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const firstSnapshot = makeAccountsJson('first@example.com', 1);
    const secondSnapshot = makeAccountsJson('second@example.com', 2);
    const latestSnapshot = makeAccountsJson('latest-with-longer-address@example.com', 3);

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(3_000, firstSnapshot.length))
      .mockResolvedValueOnce(makeStats(3_000, secondSnapshot.length))
      .mockResolvedValueOnce(makeStats(3_000, secondSnapshot.length))
      .mockResolvedValueOnce(makeStats(3_000, latestSnapshot.length))
      .mockResolvedValueOnce(makeStats(3_001, latestSnapshot.length))
      .mockResolvedValueOnce(makeStats(3_001, latestSnapshot.length));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot)
      .mockResolvedValueOnce(latestSnapshot);

    const warnSpy = vi.spyOn(logger, 'warn');

    const failClosed = await readAccountsConfig();
    expect(failClosed.accounts).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        firstRead: expect.any(Object),
        retryRead: expect.any(Object),
      }),
      'accounts_config_read_torn',
    );

    const recovered = await readAccountsConfig();
    expect(recovered.accounts).toEqual([
      expect.objectContaining({ email: 'latest-with-longer-address@example.com', hubId: 3 }),
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(3);

    rmSync(configDir, { recursive: true, force: true });
  });

  it('retries once when the first read is truncated JSON and succeeds on retry', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-parse-retry-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const validSnapshot = makeAccountsJson('recovered@example.com', 7);

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(4_000, 8))
      .mockResolvedValueOnce(makeStats(4_000, 8))
      .mockResolvedValueOnce(makeStats(4_001, validSnapshot.length))
      .mockResolvedValueOnce(makeStats(4_001, validSnapshot.length));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce('{"accounts":[{"email":"broken@example.com"')
      .mockResolvedValueOnce(validSnapshot);

    const warnSpy = vi.spyOn(logger, 'warn');

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([
      expect.objectContaining({ email: 'recovered@example.com', hubId: 7 }),
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      'accounts_config_read_torn',
    );

    rmSync(configDir, { recursive: true, force: true });
  });

  it('fails closed when both parse attempts are truncated JSON', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-parse-fail-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(5_000, 12))
      .mockResolvedValueOnce(makeStats(5_000, 12))
      .mockResolvedValueOnce(makeStats(5_000, 12))
      .mockResolvedValueOnce(makeStats(5_000, 12));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce('{"accounts":[{"email":"broken@example.com"')
      .mockResolvedValueOnce('{"accounts":[{"email":"still-broken@example.com"');

    const warnSpy = vi.spyOn(logger, 'warn');

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        firstRead: expect.objectContaining({ parseFailed: true }),
        retryRead: expect.objectContaining({ parseFailed: true }),
      }),
      'accounts_config_read_torn',
    );

    rmSync(configDir, { recursive: true, force: true });
  });

  it('treats zero-byte accounts.json as torn and fails closed after retry', async () => {
    const configDir = createConfigDir('hubspot-accounts-cache-zero-byte-');
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    __resetAccountManagerForTests();

    const statSpy = vi.spyOn(fs, 'stat');
    statSpy
      .mockResolvedValueOnce(makeStats(6_000, 0))
      .mockResolvedValueOnce(makeStats(6_000, 0))
      .mockResolvedValueOnce(makeStats(6_000, 0))
      .mockResolvedValueOnce(makeStats(6_000, 0));

    const readFileSpy = vi.spyOn(fs, 'readFile');
    readFileSpy
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const warnSpy = vi.spyOn(logger, 'warn');

    const config = await readAccountsConfig();
    expect(config.accounts).toEqual([]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        firstRead: expect.objectContaining({ parseFailed: true }),
        retryRead: expect.objectContaining({ parseFailed: true }),
      }),
      'accounts_config_read_torn',
    );

    rmSync(configDir, { recursive: true, force: true });
  });
});
