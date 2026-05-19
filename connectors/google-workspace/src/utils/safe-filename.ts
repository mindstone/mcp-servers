import path from 'path';

export function sanitizeControlledFilename(name: string, label = 'filename'): string {
  if (name.length === 0 || name.trim().length === 0) {
    throw new Error(`Invalid ${label}: must not be empty`);
  }
  if (name.includes('\0')) {
    throw new Error(`Invalid ${label}: must not contain NUL bytes`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid ${label}: must not contain path separators`);
  }
  if (name.includes('..')) {
    throw new Error(`Invalid ${label}: must not contain '..'`);
  }
  if (name.startsWith('.')) {
    throw new Error(`Invalid ${label}: must not start with a dot`);
  }

  const basename = path.basename(name);
  if (basename !== name || basename === '.' || basename === '..') {
    throw new Error(`Invalid ${label}: must be a plain filename`);
  }

  return basename;
}
