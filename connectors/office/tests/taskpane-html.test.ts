import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const taskpaneHtmlPath = path.join(__dirname, '..', 'dist', 'addin', 'taskpane.html');

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const hasBuiltTaskpaneHtml = await fileExists(taskpaneHtmlPath);

function parseHtml(html: string): Document {
  const window = new Window();
  window.document.write(html);
  window.document.close();
  return window.document;
}

function hasHiddenOrDisplayNoneAncestry(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    const style = current.getAttribute('style') ?? '';
    if (current.hasAttribute('hidden') || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i.test(style)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

describe.runIf(hasBuiltTaskpaneHtml)('built taskpane.html chat surface contract', () => {
  it('mounts the chat surface as the visible default and keeps the debug accordion collapsed', async () => {
    const html = await fs.readFile(taskpaneHtmlPath, 'utf8');
    const document = parseHtml(html);

    const chatRoot = document.querySelector('#chat-root');
    expect(chatRoot).not.toBeNull();
    expect(chatRoot?.hasAttribute('hidden')).toBe(false);
    expect(chatRoot?.getAttribute('style') ?? '').not.toMatch(/(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/i);
    expect(hasHiddenOrDisplayNoneAncestry(chatRoot!)).toBe(false);

    const debug = document.querySelector('#debug');
    expect(debug).not.toBeNull();
    expect(debug?.getAttribute('data-open')).toBe('false');

    const debugPanel = document.querySelector('#debug-panel');
    expect(debugPanel).not.toBeNull();
    expect(debugPanel?.hasAttribute('hidden')).toBe(true);
    expect(debugPanel?.textContent).toContain('Recent Commands');

    const taskpaneScript = Array.from(document.querySelectorAll('script')).find((script) =>
      (script.getAttribute('src') ?? '').endsWith('taskpane.js'),
    );
    expect(taskpaneScript).toBeDefined();
  });
});
