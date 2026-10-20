/**
 * Child process for token-write-kill.test.ts: saves token payloads in a loop
 * through the real SlackTokenProvider.saveTokens and stops one save partway
 * through writing its temp file, so the parent can SIGKILL it at a known point.
 *
 * Saves 0 to interruptAt-1 complete normally and each prints `saved <i>`. On
 * save `interruptAt`, the first write to the temp file writes only half its
 * bytes for real, prints `partial <tmpPath>`, then blocks forever.
 *
 * Only this fixture is instrumented: it wraps `fs.openSync` (to learn the temp
 * file's descriptor) and `fs.writeSync`, then calls `syncBuiltinESMExports()`
 * so the provider's `import * as fs from 'node:fs'` sees the wrappers. The
 * provider is imported after that. Progress lines go out through a direct
 * write to fd 1, so they reach the parent even though the process then blocks.
 *
 * Usage: node --import tsx test/fixtures/token-write-loop.ts <configDir> <teamId> <padBytes> <interruptAt>
 */
import type { PathLike } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');

const [configDir, teamId, padArg, interruptArg] = process.argv.slice(2);
const pad = 'x'.repeat(Number(padArg));
const interruptAt = Number(interruptArg);

const realOpenSync = fs.openSync;
const realWriteSync = fs.writeSync;
let currentSave = -1;
let tmpFd = -1;
let tmpPath = '';

fs.openSync = ((file: PathLike, ...rest: unknown[]) => {
  const fd = (realOpenSync as (...args: unknown[]) => number)(file, ...rest);
  if (String(file).includes(`${teamId}.json.tmp.`)) {
    tmpFd = fd;
    tmpPath = String(file);
  }
  return fd;
}) as typeof fs.openSync;

fs.writeSync = ((fd: number, buffer: unknown, ...rest: unknown[]) => {
  if (fd === tmpFd && currentSave === interruptAt && ArrayBuffer.isView(buffer)) {
    const [offset = 0, length = buffer.byteLength - offset] = rest as [number?, number?];
    realWriteSync(fd, buffer, offset, Math.floor(length / 2));
    realWriteSync(1, `partial ${tmpPath}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return (realWriteSync as (...args: unknown[]) => number)(fd, buffer, ...rest);
}) as typeof fs.writeSync;

syncBuiltinESMExports();

const { SlackTokenProvider } = await import('../../src/tokenProvider.js');
const tp = new SlackTokenProvider(configDir, teamId, 'cid', 'csec');

for (let i = 0; ; i++) {
  currentSave = i;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tp as any).saveTokens({
    botToken: `xoxb-${i}-${pad}`,
    botUserId: 'U999',
    botRefreshToken: `xoxe-1-loop-${i}`,
    botExpiresAt: Date.now() + 60_000,
  });
  realWriteSync(1, `saved ${i}\n`);
}
