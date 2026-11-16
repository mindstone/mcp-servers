import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../src/utils.js';

describe('htmlToPlainText', () => {
  it('drops tags and collapses whitespace', () => {
    expect(htmlToPlainText('<p>Hello</p>\n<p>World <b>again</b></p>')).toBe('Hello World again');
  });

  it('keeps a stray "<" that does not open a tag', () => {
    expect(htmlToPlainText('<p>3 < 5</p><p>and <<b>bold</b></p>')).toBe('3 < 5 and < bold');
  });

  it('runs in linear time on many unclosed "<" characters', () => {
    const html = `<p>${'<'.repeat(200_000)}`;
    const started = performance.now();
    const text = htmlToPlainText(html);
    const elapsedMs = performance.now() - started;
    expect(text).toBe('<'.repeat(200_000));
    // The old pattern took tens of seconds here; linear stripping takes milliseconds.
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
