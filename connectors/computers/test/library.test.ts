import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryFileToRead, writeNewLibraryFile } from '../src/library.js';

describe('Library copies stay inside the Library', () => {
  let env: NodeJS.ProcessEnv;
  let outside: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'computers-lib-'));
    const library = join(base, 'library');
    outside = join(base, 'secret.txt');
    mkdirSync(join(library, 'Reports'), { recursive: true });
    writeFileSync(join(library, 'Reports', 'q3.txt'), 'q3');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(library, 'link.txt'));
    symlinkSync(base, join(library, 'up'));
    env = { MCP_WORKSPACE_PATH: library };
  });

  it('reads a Library file', async () => {
    expect((await libraryFileToRead('Reports/q3.txt', env)).size).toBe(2);
  });

  it.each(['../secret.txt', '/etc/passwd', 'link.txt', 'up/secret.txt'])('refuses %s', async (path) => {
    await expect(libraryFileToRead(path, env)).rejects.toMatchObject({ code: 'OUTSIDE_LIBRARY' });
  });

  it('writes a new file and never overwrites one', async () => {
    expect(await writeNewLibraryFile('Reports/new.txt', Buffer.from('new'), env)).toBe(join('Reports', 'new.txt'));
    await expect(writeNewLibraryFile('Reports/q3.txt', Buffer.from('x'), env)).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(writeNewLibraryFile('up/escape.txt', Buffer.from('x'), env)).rejects.toMatchObject({ code: 'OUTSIDE_LIBRARY' });
    expect(readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('says plainly when the host gave no Library', async () => {
    await expect(libraryFileToRead('a.txt', {})).rejects.toMatchObject({ code: 'NO_LIBRARY' });
  });
});
