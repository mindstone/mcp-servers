import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SSHConfig from 'ssh-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findFirstIdentityFileForHost,
  findIdentityFilesForHost,
} from '../src/configEvaluator.js';

const require = createRequire(import.meta.url);

describe('config evaluator', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'replit-ssh-config-eval-'));
    mkdirSync(join(tempHome, '.ssh'), { recursive: true });
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(tempHome, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    writeFileSync(join(tempHome, '.ssh', 'config'), content, 'utf-8');
  }

  function writeKey(relativePath: string): string {
    const absolutePath = join(tempHome, '.ssh', relativePath);
    writeFileSync(absolutePath, 'dummy-private-key', 'utf-8');
    return absolutePath;
  }

  async function resolveKeyPathForHost(host: string) {
    const module = await import('../src/keyResolution.js');
    return module.resolveKeyPathForHost(host);
  }

  it('returns default key path when config is empty', async () => {
    writeConfig('');
    const result = await resolveKeyPathForHost('foo.replit.dev');

    expect(result).toEqual({
      source: 'default',
      keyPath: join(tempHome, '.ssh', 'rebel-replit'),
    });
  });

  it('returns config key path for matching Host block with tilde expansion', async () => {
    const expectedPath = writeKey('replit_key');
    writeConfig('Host *.replit.dev\n  IdentityFile ~/.ssh/replit_key\n');

    const result = await resolveKeyPathForHost('foo.replit.dev');

    expect(result).toEqual({
      source: 'config',
      keyPath: expectedPath,
    });
  });

  it('returns default key path when Host pattern does not match', async () => {
    writeConfig('Host *.replit.dev\n  IdentityFile ~/.ssh/replit_key\n');

    const result = await resolveKeyPathForHost('evil.example.com');

    expect(result).toEqual({
      source: 'default',
      keyPath: join(tempHome, '.ssh', 'rebel-replit'),
    });
  });

  it('never calls spawnSync when Match exec is present in config', async () => {
    const childProcess = require('node:child_process') as typeof import('node:child_process');
    const spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');

    writeKey('safe_key');
    writeConfig(
      [
        'Match exec "/bin/false-canary-9b3f2e"',
        '  IdentityFile ~/.ssh/evil_key',
        'Host *.replit.dev',
        '  IdentityFile ~/.ssh/safe_key',
        '',
      ].join('\n'),
    );

    const result = await resolveKeyPathForHost('foo.replit.dev');

    expect(result).toEqual({
      source: 'config',
      keyPath: join(tempHome, '.ssh', 'safe_key'),
    });
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  it('uses first matching Host block when multiple blocks match', async () => {
    const firstPath = writeKey('first_key');
    writeKey('second_key');

    writeConfig(
      [
        'Host *.replit.dev',
        '  IdentityFile ~/.ssh/first_key',
        'Host foo.replit.dev',
        '  IdentityFile ~/.ssh/second_key',
        '',
      ].join('\n'),
    );

    const result = await resolveKeyPathForHost('foo.replit.dev');

    expect(result).toEqual({
      source: 'config',
      keyPath: firstPath,
    });
  });

  it('supports IdentityFile directives with multiple values', async () => {
    const firstPath = writeKey('first_multi');
    writeKey('second_multi');
    writeConfig('Host *.replit.dev\n  IdentityFile ~/.ssh/first_multi ~/.ssh/second_multi\n');

    const result = await resolveKeyPathForHost('multi.replit.dev');

    expect(result).toEqual({
      source: 'config',
      keyPath: firstPath,
    });
  });

  it('supports ?, *, and comma-separated host globs', () => {
    const parsedConfig = SSHConfig.parse(
      'Host foo?.replit.dev,bar*.replit.dev\n  IdentityFile ~/.ssh/pattern_key\n',
    );

    expect(findFirstIdentityFileForHost(parsedConfig, 'foo1.replit.dev')).toBe(
      '~/.ssh/pattern_key',
    );
    expect(findFirstIdentityFileForHost(parsedConfig, 'bar123.replit.dev')).toBe(
      '~/.ssh/pattern_key',
    );
    expect(findIdentityFilesForHost(parsedConfig, 'foo12.replit.dev')).toEqual([]);
  });

  it('falls through to a later matching block when the first matching block sets no IdentityFile (OpenSSH first-value-wins)', async () => {
    const expectedPath = writeKey('fallback_key');
    writeConfig(
      [
        'Host *.replit.dev',
        '  Port 22',
        'Host *',
        '  IdentityFile ~/.ssh/fallback_key',
        '',
      ].join('\n'),
    );

    const result = await resolveKeyPathForHost('foo.replit.dev');

    expect(result).toEqual({
      source: 'config',
      keyPath: expectedPath,
    });
  });

  it('accumulates IdentityFile values across all matching blocks in config order', () => {
    const parsedConfig = SSHConfig.parse(
      [
        'Host *.replit.dev',
        '  IdentityFile ~/.ssh/first_key',
        'Host foo.replit.dev',
        '  IdentityFile ~/.ssh/second_key',
        '',
      ].join('\n'),
    );

    expect(findIdentityFilesForHost(parsedConfig, 'foo.replit.dev')).toEqual([
      '~/.ssh/first_key',
      '~/.ssh/second_key',
    ]);
    expect(findFirstIdentityFileForHost(parsedConfig, 'foo.replit.dev')).toBe(
      '~/.ssh/first_key',
    );
  });

  it('honours negated host patterns: an excluded host never selects the block', () => {
    const parsedConfig = SSHConfig.parse(
      'Host *.replit.dev !secret.replit.dev\n  IdentityFile ~/.ssh/pattern_key\n',
    );

    expect(findFirstIdentityFileForHost(parsedConfig, 'foo.replit.dev')).toBe(
      '~/.ssh/pattern_key',
    );
    expect(findIdentityFilesForHost(parsedConfig, 'secret.replit.dev')).toEqual([]);
  });

  it('a Host block with only negated patterns matches nothing', () => {
    const parsedConfig = SSHConfig.parse(
      'Host !foo.replit.dev\n  IdentityFile ~/.ssh/pattern_key\n',
    );

    expect(findIdentityFilesForHost(parsedConfig, 'foo.replit.dev')).toEqual([]);
    expect(findIdentityFilesForHost(parsedConfig, 'bar.replit.dev')).toEqual([]);
  });

  it('falls through to the default key for a negated host end-to-end', async () => {
    writeKey('replit_key');
    writeConfig('Host *.replit.dev !secret.replit.dev\n  IdentityFile ~/.ssh/replit_key\n');

    const excluded = await resolveKeyPathForHost('secret.replit.dev');
    expect(excluded).toEqual({
      source: 'default',
      keyPath: join(tempHome, '.ssh', 'rebel-replit'),
    });

    const included = await resolveKeyPathForHost('foo.replit.dev');
    expect(included).toEqual({
      source: 'config',
      keyPath: join(tempHome, '.ssh', 'replit_key'),
    });
  });
});
