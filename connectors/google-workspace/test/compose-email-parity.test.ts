// The historical golden remains unchanged. HTML now includes the shared send
// builder and assistant attribution, so compare the actual click against the old
// card and keep a separate byte-parity check of builder versus generated HTML.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { buildComposeAppHtml } from '@mindstone/mcp-app-compose/template';
import { COMPOSE_EMAIL_HTML } from '../src/resources/compose-email-template.js';
import { GMAIL_COMPOSE_APP_CONFIG } from '../scripts/gen-compose-html.mjs';

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/compose-email-golden.html', import.meta.url));

describe('compose-email byte parity', () => {
  it('preserves legacy click payloads against the unchanged pre-extraction golden', () => {
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    // Attribution and the shared builder intentionally change the HTML bytes.
    // Retain the historical fixture to compare actual old and new clicks.
    function clickPayload(html: string) {
      const window = new Window();
      try {
        window.document.write(html);
        let payload: unknown;
        window.parent.postMessage = (message: { method?: string; params?: unknown }) => {
          if (message.method === 'tools/call') payload = message.params;
        };
        window.eval(window.document.querySelector('script')!.textContent!);
        window.dispatchEvent(new window.MessageEvent('message', { data: {
          method: 'ui/notifications/tool-result', params: { structuredContent: {
            to: [' ada@example.com ', 'grace@example.com'], cc: [' cc@example.com '], bcc: [],
            subject: '  Update  ', body: '  indented report\n', email: 'sender@example.com',
          } },
        } }));
        window.document.getElementById('sendButton')!.click();
        expect(payload).toBeDefined();
        return payload;
      } finally { window.close(); }
    }
    expect(clickPayload(COMPOSE_EMAIL_HTML)).toEqual(clickPayload(golden));
  });

  it('shared builder with the Gmail config reproduces the committed template', () => {
    const built = buildComposeAppHtml(GMAIL_COMPOSE_APP_CONFIG);
    expect(built.length).toBe(COMPOSE_EMAIL_HTML.length);
    expect(built).toBe(COMPOSE_EMAIL_HTML);
  });
});
