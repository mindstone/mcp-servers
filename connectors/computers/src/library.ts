/**
 * Files on this device that the connector may copy to or from a computer: only inside the
 * workspace the host gives it (MCP_WORKSPACE_PATH, the person's Library), checked after
 * resolving symlinks so a link can't point a copy outside it.
 */
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ConnectorError } from './types.js';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export function libraryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.MCP_WORKSPACE_PATH?.trim();
  if (!root || !isAbsolute(root))
    throw new ConnectorError(
      'There is no Library folder to copy files to or from.',
      'NO_LIBRARY',
      'Copying needs your MCP host to share its workspace folder (the Library) with this connector through MCP_WORKSPACE_PATH. Restart the connector if that was just set.',
    );
  return root;
}

function outside(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta);
}

const refused = (path: string) =>
  new ConnectorError(`${path} is outside the Library.`, 'OUTSIDE_LIBRARY', 'Use a path relative to the Library, such as "Reports/q3.xlsx".');

/** The real path of an existing Library file to read. */
export async function libraryFileToRead(path: string, env?: NodeJS.ProcessEnv): Promise<{ absolute: string; size: number }> {
  const root = await realpath(libraryRoot(env)).catch(() => {
    throw new ConnectorError('The Library folder does not exist.', 'NO_LIBRARY', 'Check the Library location in your MCP host\'s settings, then try again.');
  });
  const lexical = resolve(root, path);
  if (outside(root, lexical)) throw refused(path);
  const actual = await realpath(lexical).catch(() => {
    throw new ConnectorError(`${path} is not in the Library.`, 'SOURCE_MISSING', 'Check the file name; paths are relative to the Library.');
  });
  if (outside(root, actual)) throw refused(path);
  const info = await stat(actual);
  if (!info.isFile()) throw new ConnectorError(`${path} is not a file.`, 'NOT_A_FILE', 'Copy one file at a time; to copy a folder, zip it first.');
  if (info.size > MAX_FILE_BYTES) throw new ConnectorError(`${path} is larger than 200 MB.`, 'FILE_TOO_LARGE', 'Split or compress it first, or have the computer download it from the web instead.');
  return { absolute: actual, size: info.size };
}

/** Writes a new Library file; never replaces one that exists. */
export async function writeNewLibraryFile(path: string, data: Buffer, env?: NodeJS.ProcessEnv): Promise<string> {
  const root = await realpath(libraryRoot(env)).catch(() => {
    throw new ConnectorError('The Library folder does not exist.', 'NO_LIBRARY', 'Check the Library location in your MCP host\'s settings, then try again.');
  });
  const lexical = resolve(root, path);
  if (outside(root, lexical)) throw refused(path);
  const folder = await realpath(dirname(lexical)).catch(() => {
    throw new ConnectorError(`The folder for ${path} does not exist in the Library.`, 'NO_FOLDER', 'Copy into an existing folder, or into the top of the Library.');
  });
  if (outside(root, folder)) throw refused(path);
  const target = resolve(folder, basename(lexical));
  const file = await open(target, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new ConnectorError(`${path} already exists in the Library.`, 'DESTINATION_EXISTS', 'Choose a new file name; copies never overwrite Library files.');
    throw new ConnectorError(`${path} could not be created in the Library.`, 'WRITE_FAILED', 'Check the folder is writable, then try again.');
  });
  try {
    await file.writeFile(data);
  } finally {
    await file.close();
  }
  return relative(root, target);
}
