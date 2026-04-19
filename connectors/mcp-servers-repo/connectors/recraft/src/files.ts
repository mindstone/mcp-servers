import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { RecraftError } from './types.js';

export interface ResolvedImageInput {
  source: string;
  filename: string;
  bytes: Buffer;
  mimeType: string;
}

function inferMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  throw new RecraftError(
    `Unsupported image type for ${filename}`,
    'UNSUPPORTED_FILE_TYPE',
    'Use PNG, JPG, JPEG, or WEBP images.',
  );
}

async function fetchRemote(url: string): Promise<ResolvedImageInput> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new RecraftError(
      `Failed to fetch remote image (${response.status})`,
      'REMOTE_FETCH_FAILED',
      'Check that the image URL is public and reachable.',
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const filename = basename(new URL(url).pathname) || 'image';
  const mimeType = response.headers.get('content-type')?.split(';')[0] || inferMimeType(filename);
  return { source: url, filename, bytes, mimeType };
}

async function readLocal(fileUri: string): Promise<ResolvedImageInput> {
  const url = new URL(fileUri);
  const path = decodeURIComponent(url.pathname);
  const bytes = await readFile(path);
  const filename = basename(path);
  const mimeType = inferMimeType(filename);
  return { source: fileUri, filename, bytes, mimeType };
}

export async function resolveImageInput(input: string): Promise<ResolvedImageInput> {
  if (input.startsWith('http://') || input.startsWith('https://')) return fetchRemote(input);
  if (input.startsWith('file://')) return readLocal(input);
  throw new RecraftError(
    'Image input must be a public URL or file:// path',
    'INVALID_IMAGE_INPUT',
    'Provide an https:// image URL or a file:// absolute path.',
  );
}

export async function buildMultipartForm(
  fields: Record<string, string | number | undefined>,
  fileEntries: Array<{ fieldName: string; input: string }>,
): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value));
  }
  for (const entry of fileEntries) {
    const resolved = await resolveImageInput(entry.input);
    const blob = new Blob([Uint8Array.from(resolved.bytes)], { type: resolved.mimeType });
    form.append(entry.fieldName, blob, resolved.filename);
  }
  return form;
}
