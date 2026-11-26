import { expect, it, vi } from 'vitest';

it('a signal after the certificate step closes the server and exits before Ready', async () => {
  const stop = vi.fn(async () => {});
  const exit = new Error('test process exit');
  vi.stubEnv('MCP_OFFICE_SIDECAR_STATE_DIR', '/unused-test-state');
  vi.doMock('../src/sidecar/index.js', () => ({
    startOfficeSidecar: async () => {
      process.emit('SIGTERM');
      return { stop };
    },
  }));
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const processExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
  const originalListeners = new Map(['disconnect', 'SIGTERM', 'SIGINT'].map(signal => [signal, process.listeners(signal)]));
  try {
    await expect(import('../src/sidecar/cli.js')).rejects.toBe(exit);
    expect(stop).toHaveBeenCalledOnce();
    expect(processExit).toHaveBeenCalledWith(1);
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    for (const [signal, originals] of originalListeners) for (const listener of process.listeners(signal)) {
      if (!originals.includes(listener)) process.off(signal, listener);
    }
    vi.doUnmock('../src/sidecar/index.js');
    stdout.mockRestore(); stderr.mockRestore(); processExit.mockRestore();
    vi.unstubAllEnvs();
  }
});
