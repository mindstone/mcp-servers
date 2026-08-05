import { inflateRawSync } from 'node:zlib';
import { wrapUntrusted } from './untrusted-content.js';

/**
 * Minimal Office Open XML text extraction (`.docx` / `.pptx`) with zero
 * dependencies. Both formats are ZIP containers of XML parts, so a small
 * central-directory reader plus Node's built-in zlib is enough to pull the
 * main document / slide parts and strip their markup.
 *
 * Scope is deliberately narrow: stored and deflated entries only, no data
 * descriptors or ZIP64 (Office writers always populate the central directory
 * sizes this reader relies on). Anything unexpected raises
 * InvalidOfficeDocumentError, which the caller maps to user-facing guidance.
 *
 * Decompression is bounded in both dimensions because the input is an
 * attacker-controllable download: each entry inflates through zlib's
 * `maxOutputLength` (a ZIP bomb trips ERR_BUFFER_TOO_LARGE, mapped to
 * InvalidOfficeDocumentError), the declared uncompressed size is checked
 * BEFORE inflating, and a cumulative budget stops many-small-entries attacks.
 */

export class InvalidOfficeDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOfficeDocumentError';
  }
}

/** A 20MB .docx/.pptx expands to low-double-digit MB of XML in practice. */
export const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;

/** Entry names come from the wire; envelope them in error messages. */
function safeEntryName(name: string): string {
  return wrapUntrusted(name, 'microsoft-files:office:zipEntryName') ?? '';
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  // EOCD is 22 bytes plus up to 64KB of trailing comment; scan backwards.
  const floor = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= floor; i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new InvalidOfficeDocumentError('not a ZIP container (no end-of-central-directory record)');
}

function listZipEntries(bytes: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length) {
      throw new InvalidOfficeDocumentError('truncated ZIP central directory');
    }
    if (bytes.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new InvalidOfficeDocumentError('corrupt ZIP central directory');
    }
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > bytes.length) {
      throw new InvalidOfficeDocumentError('truncated ZIP central directory entry');
    }
    entries.push({
      name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8'),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

interface InflationBudget {
  remaining: number;
}

function readZipEntry(bytes: Buffer, entry: ZipEntry, budget: InflationBudget): Buffer {
  const allowed = Math.min(MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES, budget.remaining);
  if (entry.uncompressedSize > allowed) {
    throw new InvalidOfficeDocumentError(
      `ZIP entry ${safeEntryName(entry.name)} declares an uncompressed size above the extraction limit`,
    );
  }
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.length) {
    throw new InvalidOfficeDocumentError(
      `truncated ZIP local header for ${safeEntryName(entry.name)}`,
    );
  }
  if (bytes.readUInt32LE(offset) !== LOCAL_HEADER_SIGNATURE) {
    throw new InvalidOfficeDocumentError(`corrupt ZIP local header for ${safeEntryName(entry.name)}`);
  }
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > bytes.length) {
    throw new InvalidOfficeDocumentError(
      `truncated ZIP entry data for ${safeEntryName(entry.name)}`,
    );
  }
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  let inflated: Buffer;
  if (entry.compressionMethod === 0) {
    inflated = Buffer.from(compressed);
  } else if (entry.compressionMethod === 8) {
    try {
      // maxOutputLength makes inflation itself fail closed even when the
      // declared size lies, so a ZIP bomb cannot expand in memory.
      inflated = inflateRawSync(compressed, { maxOutputLength: allowed + 1 });
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'ERR_BUFFER_TOO_LARGE') {
        throw new InvalidOfficeDocumentError(
          `ZIP entry ${safeEntryName(entry.name)} exceeds the extraction size limit`,
        );
      }
      throw new InvalidOfficeDocumentError(`cannot inflate ZIP entry ${safeEntryName(entry.name)}`);
    }
  } else {
    throw new InvalidOfficeDocumentError(
      `unsupported ZIP compression method ${entry.compressionMethod} for ${safeEntryName(entry.name)}`,
    );
  }
  budget.remaining -= inflated.length;
  if (budget.remaining < 0) {
    throw new InvalidOfficeDocumentError('ZIP contents exceed the total extraction size limit');
  }
  return inflated;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractDocxText(bytes: Buffer): string {
  const budget: InflationBudget = { remaining: MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES };
  const entry = listZipEntries(bytes).find((e) => e.name === 'word/document.xml');
  if (!entry) {
    throw new InvalidOfficeDocumentError('no word/document.xml part found');
  }
  const xml = readZipEntry(bytes, entry, budget).toString('utf-8');
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n');
  const text = decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ''));
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function extractPptxText(bytes: Buffer): string {
  const budget: InflationBudget = { remaining: MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES };
  const slides = listZipEntries(bytes)
    .map((entry) => ({ entry, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name) }))
    .filter((slide): slide is { entry: ZipEntry; match: RegExpExecArray } => slide.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (slides.length === 0) {
    throw new InvalidOfficeDocumentError('no ppt/slides parts found');
  }
  return slides
    .map(({ entry, match }) => {
      const xml = readZipEntry(bytes, entry, budget).toString('utf-8');
      const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeXmlEntities(m[1] ?? ''))
        .filter((text) => text.length > 0);
      return `--- Slide ${match[1]} ---\n${runs.join('\n')}`;
    })
    .join('\n\n');
}
