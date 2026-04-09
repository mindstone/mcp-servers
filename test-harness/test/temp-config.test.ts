import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTempConfig } from '../src/index.js';

describe('createTempConfig', () => {
  it('creates temp directory with accounts.json (VAL-FOUND-004)', () => {
    const result = createTempConfig({
      accounts: [{ subdomain: 'test', email: 'a@test.com', apiToken: 'tok' }],
      defaultAccount: 'test',
    });

    try {
      // Directory exists
      expect(fs.existsSync(result.configPath)).toBe(true);

      // accounts.json exists with correct content
      const accountsPath = path.join(result.configPath, 'accounts.json');
      expect(fs.existsSync(accountsPath)).toBe(true);
      const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      expect(accounts.accounts).toHaveLength(1);
      expect(accounts.accounts[0].subdomain).toBe('test');
      expect(accounts.defaultSubdomain).toBe('test');
    } finally {
      result.cleanup();
    }
  });

  it('cleanup removes directory (VAL-FOUND-004)', () => {
    const result = createTempConfig({
      accounts: [{ subdomain: 'test', email: 'a@test.com' }],
    });

    // Verify directory exists before cleanup
    expect(fs.existsSync(result.configPath)).toBe(true);

    result.cleanup();

    // Verify directory is gone after cleanup
    expect(fs.existsSync(result.configPath)).toBe(false);
  });

  it('creates bridge state file', () => {
    const result = createTempConfig();

    try {
      expect(fs.existsSync(result.bridgeStatePath)).toBe(true);
    } finally {
      result.cleanup();
    }
  });

  it('creates empty config dir when empty option is true', () => {
    const result = createTempConfig({ empty: true });

    try {
      expect(fs.existsSync(result.configPath)).toBe(true);
      const accountsPath = path.join(result.configPath, 'accounts.json');
      expect(fs.existsSync(accountsPath)).toBe(false);
    } finally {
      result.cleanup();
    }
  });

  it('creates credentials directory with token files', () => {
    const result = createTempConfig({
      credentials: [
        {
          filename: 'testcorp.token.json',
          data: {
            access_token: 'test-access',
            refresh_token: 'test-refresh',
            expires_in: 7200,
          },
        },
      ],
    });

    try {
      const credDir = path.join(result.configPath, 'credentials');
      expect(fs.existsSync(credDir)).toBe(true);

      const tokenPath = path.join(credDir, 'testcorp.token.json');
      expect(fs.existsSync(tokenPath)).toBe(true);

      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      expect(tokenData.access_token).toBe('test-access');
      expect(tokenData.refresh_token).toBe('test-refresh');
    } finally {
      result.cleanup();
    }
  });

  it('uses custom prefix for temp directory', () => {
    const result = createTempConfig({ prefix: 'zendesk-test-' });

    try {
      expect(result.configPath).toContain('zendesk-test-');
    } finally {
      result.cleanup();
    }
  });

  it('supports custom defaultAccountKey', () => {
    const result = createTempConfig({
      accounts: [{ domain: 'example.freshdesk.com' }],
      defaultAccount: 'example.freshdesk.com',
      defaultAccountKey: 'defaultDomain',
    });

    try {
      const accountsPath = path.join(result.configPath, 'accounts.json');
      const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
      expect(accounts.defaultDomain).toBe('example.freshdesk.com');
    } finally {
      result.cleanup();
    }
  });

  it('sets secure file permissions on accounts.json', () => {
    const result = createTempConfig({
      accounts: [{ subdomain: 'test' }],
    });

    try {
      const accountsPath = path.join(result.configPath, 'accounts.json');
      const stats = fs.statSync(accountsPath);
      // 0o600 = owner read/write only
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      result.cleanup();
    }
  });

  it('sets secure permissions on credential files', () => {
    const result = createTempConfig({
      credentials: [
        { filename: 'test.token.json', data: { token: 'secret' } },
      ],
    });

    try {
      const tokenPath = path.join(result.configPath, 'credentials', 'test.token.json');
      const stats = fs.statSync(tokenPath);
      expect(stats.mode & 0o777).toBe(0o600);

      const credDir = path.join(result.configPath, 'credentials');
      const dirStats = fs.statSync(credDir);
      expect(dirStats.mode & 0o777).toBe(0o700);
    } finally {
      result.cleanup();
    }
  });
});
