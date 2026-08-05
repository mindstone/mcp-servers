import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InvalidOfficeDocumentError,
  MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  extractDocxText,
  extractPptxText,
} from '../src/office-text.js';

const docx = readFileSync(new URL('./fixtures/files/sample.docx', import.meta.url));
const pptx = readFileSync(new URL('./fixtures/files/sample.pptx', import.meta.url));

describe('extractDocxText', () => {
  it('extracts paragraph text with line breaks and decoded entities', () => {
    const text = extractDocxText(docx);
    expect(text).toContain('Quarterly Results & Outlook');
    expect(text).toContain('Revenue grew 12% year over year.');
    expect(text).toContain('See appendix <draft> for details.');
    expect(text.split('\n')).toHaveLength(3);
  });

  it('rejects non-ZIP input', () => {
    expect(() => extractDocxText(Buffer.from('this is not a zip archive'))).toThrow(
      InvalidOfficeDocumentError,
    );
  });

  it('rejects a ZIP without the main document part', () => {
    expect(() => extractDocxText(pptx)).toThrow('no word/document.xml part found');
  });
});

describe('extractPptxText', () => {
  it('extracts slide text in numeric slide order', () => {
    const text = extractPptxText(pptx);
    const slide1 = text.indexOf('--- Slide 1 ---');
    const slide2 = text.indexOf('--- Slide 2 ---');
    const slide10 = text.indexOf('--- Slide 10 ---');
    expect(slide1).toBeGreaterThanOrEqual(0);
    expect(slide2).toBeGreaterThan(slide1);
    expect(slide10).toBeGreaterThan(slide2);
    expect(text).toContain('Launch Plan');
    expect(text).toContain('Agenda <draft>');
    expect(text).toContain('Budget & timing');
    expect(text).toContain('Owner: Jane');
  });

  it('rejects a ZIP without slide parts', () => {
    expect(() => extractPptxText(docx)).toThrow('no ppt/slides parts found');
  });
});

// ---------------------------------------------------------------------------
// Decompression bounds — adversarial ZIP containers built programmatically.
// ---------------------------------------------------------------------------

interface TestZipEntry {
  name: string;
  method: number;
  data: Buffer;
  declaredCompressed?: number;
  declaredUncompressed?: number;
}

function buildZip(entries: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const compSize = entry.declaredCompressed ?? entry.data.length;
    const uncompSize = entry.declaredUncompressed ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

describe('decompression bounds', () => {
  it('rejects an entry whose declared uncompressed size exceeds the limit, pre-inflation', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const zip = buildZip([
      {
        name: 'word/document.xml',
        method: 8,
        data: deflateRawSync(Buffer.from('<w:p>hi</w:p>')),
        declaredUncompressed: MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1,
      },
    ]);
    expect(() => extractDocxText(zip)).toThrow('above the extraction limit');
  });

  it('rejects an entry that inflates past the limit even when the declared size lies', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const bomb = Buffer.alloc(MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES + 1024, 0x61);
    const zip = buildZip([
      {
        name: 'word/document.xml',
        method: 8,
        data: deflateRawSync(bomb),
        declaredUncompressed: 100,
      },
    ]);
    expect(() => extractDocxText(zip)).toThrow('exceeds the extraction size limit');
  });

  it('enforces a cumulative inflation budget across slide entries', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const fiftyMb = 50 * 1024 * 1024;
    const chunk = deflateRawSync(Buffer.alloc(fiftyMb, 0x62));
    const zip = buildZip(
      [1, 2, 3].map((i) => ({
        name: `ppt/slides/slide${i}.xml`,
        method: 8,
        data: chunk,
        declaredUncompressed: fiftyMb,
      })),
    );
    expect(() => extractPptxText(zip)).toThrow('above the extraction limit');
  });

  it('rejects a truncated ZIP (cut EOCD) with InvalidOfficeDocumentError', () => {
    const zip = buildZip([
      { name: 'word/document.xml', method: 0, data: Buffer.from('<w:p>x</w:p>') },
    ]);
    const truncated = Buffer.from(zip.subarray(0, zip.length - 10));
    expect(() => extractDocxText(truncated)).toThrow(InvalidOfficeDocumentError);
  });

  it('rejects a local-header offset beyond the buffer instead of throwing a raw RangeError', () => {
    const zip = Buffer.from(
      buildZip([{ name: 'word/document.xml', method: 0, data: Buffer.from('<w:p>x</w:p>') }]),
    );
    const sig = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(sig).toBeGreaterThan(-1);
    zip.writeUInt32LE(zip.length + 4096, sig + 42);
    expect(() => extractDocxText(zip)).toThrow(InvalidOfficeDocumentError);
  });

  it('rejects entry data that overruns the buffer (truncated payload)', () => {
    const zip = Buffer.from(
      buildZip([
        {
          name: 'word/document.xml',
          method: 0,
          data: Buffer.from('<w:p>x</w:p>'),
          declaredCompressed: 0x1000,
        },
      ]),
    );
    expect(() => extractDocxText(zip)).toThrow('truncated ZIP entry data');
  });
});
