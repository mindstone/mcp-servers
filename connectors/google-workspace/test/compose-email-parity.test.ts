// Byte-parity guards for the compose app extraction (shared
// @mindstone/mcp-app-compose builder -> committed template):
//
// 1. The committed COMPOSE_EMAIL_HTML matches the golden fixture captured from
//    the pre-extraction, hand-maintained template. This pins the exact bytes
//    the connector shipped before the builder existed.
// 2. Building with the connector's real config (the same object the generator
//    script uses) reproduces the committed template. This proves the generator
//    pipeline is lossless end-to-end, not just that someone committed the
//    right bytes once.
//
// If a deliberate change to the shared builder lands, regenerate via
// `npm run compose:template` and update the golden fixture in the same change.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildComposeAppHtml } from '@mindstone/mcp-app-compose/template';
import { COMPOSE_EMAIL_HTML } from '../src/resources/compose-email-template.js';
import { GMAIL_COMPOSE_APP_CONFIG } from '../scripts/gen-compose-html.mjs';

const GOLDEN_PATH = fileURLToPath(new URL('./fixtures/compose-email-golden.html', import.meta.url));

describe('compose-email byte parity', () => {
  it('committed template matches the pre-extraction golden byte-for-byte', () => {
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    expect(COMPOSE_EMAIL_HTML.length).toBe(golden.length);
    expect(COMPOSE_EMAIL_HTML).toBe(golden);
  });

  it('shared builder with the Gmail config reproduces the committed template', () => {
    const built = buildComposeAppHtml(GMAIL_COMPOSE_APP_CONFIG);
    expect(built.length).toBe(COMPOSE_EMAIL_HTML.length);
    expect(built).toBe(COMPOSE_EMAIL_HTML);
  });
});
