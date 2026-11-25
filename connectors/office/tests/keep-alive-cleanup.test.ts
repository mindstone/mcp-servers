import { mkdir, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKeepAliveFixture, proof } from './fixtures/keep-alive.js';

it.skipIf(process.platform !== 'linux')('reports an unidentified helper without requesting or signalling', async () => {
  const fixture = await createKeepAliveFixture();
  await mkdir(fixture.stateDirectory);
  await writeFile(fixture.stateFile, JSON.stringify({ pid: process.pid, port: 52100, token: 'dummy-cleanup-token' }));
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const get = vi.spyOn(https, 'get').mockImplementation(() => { throw new Error('https.get intercepted during unidentified cleanup'); });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('process.kill intercepted during unidentified cleanup'); });
  try {
    await expect(fixture.cleanup()).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(fixture.pid).toBeUndefined();
    expect(output).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ event: 'cleanup-unidentified', stateFilePresent: true, signalled: false })}\n`);
    expect(output).not.toHaveBeenCalledWith(expect.stringContaining('"event":"cleanup"'));
  } finally {
    const observation = {
      httpsCalls: get.mock.calls.length, signalCalls: kill.mock.calls.length,
      fixturePidUndefined: fixture.pid === undefined,
      preRequestChecks: output.mock.calls.filter(([line]) => String(line).includes('"passed":true')).length,
      unidentifiedEvents: output.mock.calls.filter(([line]) => String(line).includes('"event":"cleanup-unidentified"')).length,
      cleanupEvents: output.mock.calls.filter(([line]) => String(line).includes('"event":"cleanup"')).length,
    };
    get.mockRestore();
    kill.mockRestore();
    output.mockRestore();
    proof('cleanup-negative-observation', observation);
    await rm(dirname(fixture.stateDirectory), { recursive: true, force: true });
  }
});
