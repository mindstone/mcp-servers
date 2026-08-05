import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildComposeAppHtml } from '@mindstone/mcp-app-compose/template';
import { COMPOSE_EMAIL_HTML } from '../src/resources/compose-email-template.js';
import { buildFileContents, OUTLOOK_COMPOSE_APP_CONFIG } from '../scripts/gen-compose-html.mjs';

// The committed template is generated from the shared @mindstone/mcp-app-compose
// builder; these tests pin the Outlook-specific knobs and prove the committed
// files match what the generator produces today (byte parity, same guarantee
// as the pretest --check gate but visible in the test report).

describe('compose-email template generation parity', () => {
  it('pins the Outlook configuration of the shared compose app', () => {
    expect(OUTLOOK_COMPOSE_APP_CONFIG).toEqual({
      resourceUri: 'ui://microsoft-mail/compose-email',
      sendToolName: 'send_email',
      fromMissingHelperText:
        'Rebel could not confirm the sending account. Cancel and ask Rebel to recreate the draft before sending.',
      fields: { cc: true, bcc: true },
      deepLink: { kind: 'none' },
    });
  });

  it('shared builder with the Outlook config reproduces the committed template', () => {
    const built = buildComposeAppHtml(OUTLOOK_COMPOSE_APP_CONFIG);
    expect(built.length).toBe(COMPOSE_EMAIL_HTML.length);
    expect(built).toBe(COMPOSE_EMAIL_HTML);
  });

  it('matches the committed template and preview byte-for-byte', () => {
    const { templateTs, previewHtml } = buildFileContents();
    const committedTemplate = fs.readFileSync(
      new URL('../src/resources/compose-email-template.ts', import.meta.url),
      'utf8',
    );
    const committedPreview = fs.readFileSync(
      new URL('../src/resources/compose-email.html', import.meta.url),
      'utf8',
    );
    expect(committedTemplate).toBe(templateTs);
    expect(committedPreview).toBe(previewHtml);
  });
});

describe('compose-email template contents', () => {
  it('bakes in the Outlook resource URI and send tool', () => {
    expect(COMPOSE_EMAIL_HTML).toContain("var RESOURCE_URI = 'ui://microsoft-mail/compose-email'");
    expect(COMPOSE_EMAIL_HTML).toContain("name: 'send_email'");
    expect(COMPOSE_EMAIL_HTML).toContain(
      'Rebel could not confirm the sending account. Cancel and ask Rebel to recreate the draft before sending.',
    );
  });

  it('keeps the shared send timeout and pre-A0 package_id shim', () => {
    expect(COMPOSE_EMAIL_HTML).toContain('SEND_TIMEOUT_MS = 75000');
    expect(COMPOSE_EMAIL_HTML).toContain('package_id');
  });

  it('renders CC and BCC fields (send_email accepts both)', () => {
    expect(COMPOSE_EMAIL_HTML).toContain('ccInput');
    expect(COMPOSE_EMAIL_HTML).toContain('toggleCcButton');
    for (const marker of ['bccInput', 'toggleBccButton', 'bccRow', 'sentBccField']) {
      expect(COMPOSE_EMAIL_HTML, marker).toContain(marker);
    }
  });

  it('carries no Gmail deep-link subsystem', () => {
    for (const marker of ['buildGmailUrl', 'mail.google.com', 'openGmailButton', 'gmailUrl']) {
      expect(COMPOSE_EMAIL_HTML, marker).not.toContain(marker);
    }
  });
});
