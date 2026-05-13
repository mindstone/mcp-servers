import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRemoveAccount } from '../src/tools/account-handlers.js';
import {
  __resetAccountManagerForTests,
  sanitizeEmail,
} from '../src/modules/accounts/manager.js';
import logger from '../src/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '../src');
const CONFIGURED_EMAIL = 'configured@example.com';
const TEST_TELEMETRY_SALT_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function createConfigDir(): string {
  const configDir = mkdtempSync(join(tmpdir(), 'hubspot-h1-logs-'));
  mkdirSync(join(configDir, 'credentials'), { recursive: true });
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email: CONFIGURED_EMAIL, hubId: 12345678 }] }),
  );
  writeFileSync(
    join(configDir, 'credentials', `${sanitizeEmail(CONFIGURED_EMAIL)}.token.json`),
    JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 86_400_000,
      hub_id: 12345678,
      user: CONFIGURED_EMAIL,
      schemaVersion: 1,
    }),
  );
  return configDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetAccountManagerForTests();
  delete process.env.HUBSPOT_CONFIG_DIR;
  delete process.env.HUBSPOT_ACCOUNT_EMAIL;
  delete process.env.HUBSPOT_TELEMETRY_SALT;
});

describe('account email log redaction', () => {
  it('does not interpolate raw account email variables into logger or console calls', () => {
    const violations: string[] = [];
    const callStartPattern = /(?:logger|console)\.(?:info|warn|error|debug)\(/;
    const rawEmailInterpolationPattern = /\$\{(?:email|args\.email|targetEmail|accountEmail)\}/;

    for (const file of collectTsFiles(SRC_DIR)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!callStartPattern.test(lines[index])) {
          continue;
        }
        const window = lines.slice(index, index + 5).join('\n');
        if (rawEmailInterpolationPattern.test(window)) {
          violations.push(`${path.relative(SRC_DIR, file)}:${index + 1}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('logs remove-account success with an account hash instead of a raw email string', async () => {
    const configDir = createConfigDir();
    process.env.HUBSPOT_CONFIG_DIR = configDir;
    process.env.HUBSPOT_ACCOUNT_EMAIL = CONFIGURED_EMAIL;
    process.env.HUBSPOT_TELEMETRY_SALT = TEST_TELEMETRY_SALT_HEX;
    __resetAccountManagerForTests();
    const infoSpy = vi.spyOn(logger, 'info');

    await handleRemoveAccount({ email: CONFIGURED_EMAIL });

    expect(infoSpy).toHaveBeenCalledWith(
      { account: expect.stringMatching(/^[a-f0-9]{64}$/) },
      'account_removed',
    );
    const serializedCalls = JSON.stringify(infoSpy.mock.calls);
    expect(serializedCalls).not.toContain('@');
    expect(serializedCalls).not.toContain(CONFIGURED_EMAIL);
    expect(existsSync(join(configDir, 'credentials', `${sanitizeEmail(CONFIGURED_EMAIL)}.token.json`))).toBe(false);

    rmSync(configDir, { recursive: true, force: true });
  });
});
