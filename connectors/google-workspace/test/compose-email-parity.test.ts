// Byte-parity guards for the compose app extraction (shared
// @mindstone/mcp-app-compose builder -> committed template):
//
// 1. The committed COMPOSE_EMAIL_HTML matches the golden fixture. The golden was
//    originally captured from the pre-extraction, hand-maintained template to
//    pin the exact bytes the connector shipped before the builder existed. It
//    has since been deliberately rebaselined once (2026-07) to strip internal
//    ticket references out of the shared builder per the public-repo policy, so
//    it now pins the intended current output rather than the original bytes.
// 2. Building with the connector's real config (the same object the generator
//    script uses) reproduces the committed template. This proves the generator
//    pipeline is lossless end-to-end, not just that someone committed the
//    right bytes once.
//
// REBASELINE CONTROL: assertions 1+2 only stay honest if the golden is NOT
// updated casually. A change that touches the builder AND regenerates the
// template AND updates the golden in a single commit collapses "byte parity"
// into "all three files moved together" and loses its regression value. So any
// golden update MUST be a conscious, reviewer-acknowledged behavioural
// rebaseline: state the byte delta and the reason in the commit/PR (exactly as
// the 2026-07 ticket-ref scrub did). For a change you believe is
// non-behavioural, expect this test to FAIL first and treat that failure as the
// prompt to justify the rebaseline — never silently `cp` the new bytes over the
// golden to make it green.
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
