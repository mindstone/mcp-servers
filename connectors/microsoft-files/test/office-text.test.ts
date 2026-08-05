import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InvalidOfficeDocumentError,
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
