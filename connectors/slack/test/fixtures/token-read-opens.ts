/**
 * Shared helpers for tests that mock `fs.openSync` to stand for the token
 * write path.
 *
 * Token reads open the file with numeric flags that carry no write bits
 * (O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND) before reading through the
 * descriptor, so a test counting or failing write-path opens must let those
 * read opens through. Each test file keeps its own `vi.mock('node:fs')`
 * registration and passes its mocked and real `openSync` in explicitly.
 */
import * as fs from 'node:fs';
import type { Mock } from 'vitest';

/** True only for numeric flags with none of the access/write bits set. */
export function isReadOpen(flags: unknown): boolean {
  if (typeof flags !== 'number') return false;
  const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) === 0;
}

/**
 * Make `mockedOpenSync` call `error` for the next `times` write-path opens;
 * read opens and later write opens go to `realOpenSync`.
 */
export function failWritePathOpens(
  mockedOpenSync: Mock<typeof fs.openSync>,
  realOpenSync: typeof fs.openSync,
  error: () => never,
  times = Infinity,
): void {
  let remaining = times;
  mockedOpenSync.mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null) => {
    if (!isReadOpen(flags) && remaining-- > 0) error();
    return realOpenSync(p, flags, mode);
  }) as typeof fs.openSync);
}
