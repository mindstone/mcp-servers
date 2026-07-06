import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { buildComposeAppHtml, type ComposeAppConfig } from '../src/index.js';

// Gmail-shaped config. The authoritative byte-parity pin against the shipped
// Gmail template lives in the google-workspace connector
// (test/compose-email-parity.test.ts); the assertions here are the
// package-local invariant checks that hold for every consumer.
const GMAIL_CONFIG: ComposeAppConfig = {
  resourceUri: 'ui://google-workspace/compose-email',
  sendToolName: 'send_workspace_email',
  fromMissingHelperText:
    'Rebel could not confirm the sending account. Cancel and ask Rebel to recreate the draft before sending.',
  fields: { cc: true, bcc: true },
  deepLink: { kind: 'gmail' },
};

// A plausible second consumer: CC but no BCC (send tool has no BCC parameter)
// and no deep-link subsystem. The apostrophe in the helper copy exercises the
// single-quote escaping of spliced config strings.
const ACME_CONFIG: ComposeAppConfig = {
  resourceUri: 'ui://acme-mail/compose-email',
  sendToolName: 'send_acme_email',
  fromMissingHelperText: "Acme Mail can't confirm the sending account. Cancel and recreate the draft.",
  fields: { cc: true, bcc: false },
  deepLink: { kind: 'none' },
};

const gmailHtml = buildComposeAppHtml(GMAIL_CONFIG);
const acmeHtml = buildComposeAppHtml(ACME_CONFIG);

let composeWindow: Window | undefined;

afterEach(() => {
  composeWindow?.close();
  composeWindow = undefined;
});

function loadWindow(html: string): Window {
  const window = new Window({ url: 'https://example.com/compose-email.html' });
  composeWindow = window;
  window.document.write(html);
  window.parent.postMessage = vi.fn();
  const script = window.document.querySelector('script');
  expect(script?.textContent).toBeTruthy();
  window.eval(script?.textContent ?? '');
  return window;
}

function setFieldValue(window: Window, id: string, value: string): void {
  const element = window.document.getElementById(id) as unknown as HTMLInputElement | HTMLTextAreaElement;
  expect(element).toBeTruthy();
  element.value = value;
  element.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
}

function isHidden(window: Window, id: string): boolean {
  const element = window.document.getElementById(id);
  expect(element).toBeTruthy();
  return (element as unknown as HTMLElement).classList.contains('hidden');
}

function postedMessages(window: Window): Array<Record<string, any>> {
  const postMessage = window.parent.postMessage as unknown as { mock: { calls: Array<[Record<string, any>]> } };
  return postMessage.mock.calls.map((call) => call[0]);
}

describe('buildComposeAppHtml — shared invariants (Gmail-shaped config)', () => {
  it('is a complete HTML document with the historical leading newline', () => {
    expect(gmailHtml.startsWith('\n<!DOCTYPE html>')).toBe(true);
    expect(gmailHtml.endsWith('</html>\n')).toBe(true);
  });

  it('keeps the theme system: host context, data-theme attributes, dark-mode fallback', () => {
    expect(gmailHtml).toContain('@media (prefers-color-scheme: dark)');
    expect(gmailHtml).toContain('html[data-theme="dark"]');
    expect(gmailHtml).toContain('html[data-theme="light"]');
    expect(gmailHtml).toContain('function applyThemeFromHostContext');
    expect(gmailHtml).toContain('__MCP_HOST_CONTEXT__');
  });

  it('keeps the three-view state machine and the expand-after-send rule', () => {
    expect(gmailHtml).toContain('id="collapsedState"');
    expect(gmailHtml).toContain('id="composeForm"');
    expect(gmailHtml).toContain('id="sentView"');
    expect(gmailHtml).toContain('novalidate');
    expect(gmailHtml).toContain("showView(sent ? 'sent' : 'form')");
  });

  it('keeps the send lifecycle: 75s lost-reply timeout and the unknown-outcome state', () => {
    expect(gmailHtml).toContain('var SEND_TIMEOUT_MS = 75000;');
    expect(gmailHtml).toContain('function showSendUnknown');
    expect(gmailHtml).toContain('function handleSendTimeout');
    expect(gmailHtml).toContain("'send-' + Date.now() + '-' + Math.random().toString(16).slice(2)");
  });

  it('keeps the address helpers', () => {
    expect(gmailHtml).toContain('function formatAddressItem');
    expect(gmailHtml).toContain('function normalizeAddressList');
  });

  it('keeps the permanent pre-A0 envelope migration shim', () => {
    expect(gmailHtml).toContain('MIGRATION SHIM');
    expect(gmailHtml).toContain('PERMANENT');
    expect(gmailHtml).toContain('"package_id"');
    expect(gmailHtml).toContain('Migration shim');
  });

  it('keeps the host protocol: ready, initialize, resize, tool-result', () => {
    expect(gmailHtml).toContain('mcp-app:ready');
    expect(gmailHtml).toContain("method: 'ui/initialize'");
    expect(gmailHtml).toContain("id: 'compose-email-init'");
    expect(gmailHtml).toContain("method: 'ui/resize'");
    expect(gmailHtml).toContain('ResizeObserver');
    expect(gmailHtml).toContain("'ui/notifications/tool-result'");
  });

  it('keeps the click-not-submit sandbox workaround and its explanatory comment', () => {
    expect(gmailHtml).toContain('Blocked form submission');
    expect(gmailHtml).toContain('allow-forms');
    expect(gmailHtml).toContain("sendButton.addEventListener('click'");
    expect(gmailHtml).toContain("composeForm.addEventListener('submit'");
  });

  it('inlines the Gmail deep-link subsystem when deepLink.kind is gmail', () => {
    expect(gmailHtml).toContain('function buildGmailUrl');
    expect(gmailHtml).toContain('function getSendMetaFromResult');
    expect(gmailHtml).toContain("'https://mail.google.com/mail/u/' + userPart + '/#all/' + encodeURIComponent(id)");
    expect(gmailHtml).toContain('/^[A-Za-z0-9_-]+$/');
    expect(gmailHtml).toContain('id="openGmailButton"');
    expect(gmailHtml).toContain("method: 'ui/open-external-link'");
  });

  it('splices the connector-specific config values', () => {
    expect(gmailHtml).toContain("var RESOURCE_URI = 'ui://google-workspace/compose-email';");
    expect(gmailHtml).toContain("name: 'send_workspace_email',");
    expect(gmailHtml).toContain(
      "fromHelper.textContent = 'Rebel could not confirm the sending account. Cancel and ask Rebel to recreate the draft before sending.';",
    );
  });
});

describe('buildComposeAppHtml — field visibility and deep-link omission', () => {
  it('omits every trace of BCC when fields.bcc is false', () => {
    for (const marker of ['bccInput', 'bccRow', 'toggleBccButton', 'sentBcc', 'Add BCC', 'draft.bcc', 'payload.bcc']) {
      expect(acmeHtml).not.toContain(marker);
    }
    // CC survives independently.
    expect(acmeHtml).toContain('id="ccRow"');
    expect(acmeHtml).toContain('toggleCcButton');
  });

  it('omits every trace of CC when fields.cc is false', () => {
    const html = buildComposeAppHtml({ ...GMAIL_CONFIG, fields: { cc: false, bcc: true } });
    // Quoted-id markers: bare 'ccInput'/'ccRow' are substrings of the BCC ids,
    // which legitimately remain.
    for (const marker of ["'ccInput'", "'ccRow'", 'toggleCcButton', 'sentCcField', 'Add CC', 'draft.cc', 'payload.cc']) {
      expect(html).not.toContain(marker);
    }
    expect(html).toContain('id="bccRow"');
  });

  it('omits the toggle row entirely when both cc and bcc are off', () => {
    const html = buildComposeAppHtml({ ...GMAIL_CONFIG, fields: { cc: false, bcc: false } });
    expect(html).not.toContain('class="toggles"');
    expect(html).toContain('[toInput, subjectInput, bodyInput].forEach');
  });

  it('omits the whole deep-link subsystem when deepLink.kind is none', () => {
    for (const marker of [
      'openGmailButton',
      'buildGmailUrl',
      'looksLikeEmail',
      'gmailUrl',
      'mail.google.com',
      'ui/open-external-link',
      'Gmail',
    ]) {
      expect(acmeHtml).not.toContain(marker);
    }
    // The send-meta extractor stays: future deep-link kinds consume it.
    expect(acmeHtml).toContain('function getSendMetaFromResult');
  });

  it('escapes apostrophes in spliced helper copy', () => {
    expect(acmeHtml).toContain(
      "fromHelper.textContent = 'Acme Mail can\\'t confirm the sending account. Cancel and recreate the draft.';",
    );
  });
});

describe('buildComposeAppHtml — config validation', () => {
  it('rejects a resourceUri that is not a plain ui:// URI', () => {
    expect(() => buildComposeAppHtml({ ...GMAIL_CONFIG, resourceUri: 'https://example.com/x' })).toThrow(
      /resourceUri/,
    );
    expect(() => buildComposeAppHtml({ ...GMAIL_CONFIG, resourceUri: "ui://a/b';alert(1)//" })).toThrow(
      /resourceUri/,
    );
  });

  it('rejects a sendToolName with characters outside the tool-name alphabet', () => {
    expect(() => buildComposeAppHtml({ ...GMAIL_CONFIG, sendToolName: "send'; window.x = 1; '" })).toThrow(
      /sendToolName/,
    );
    expect(() => buildComposeAppHtml({ ...GMAIL_CONFIG, sendToolName: '' })).toThrow(/sendToolName/);
  });

  it('rejects helper copy that could escape its splice context', () => {
    for (const bad of ['has <markup>', 'closes </script> tag', 'back`tick', 'back\\slash', 'multi\nline', '']) {
      expect(() => buildComposeAppHtml({ ...GMAIL_CONFIG, fromMissingHelperText: bad })).toThrow(
        /fromMissingHelperText/,
      );
    }
  });

  it('rejects malformed fields and deepLink discriminators', () => {
    expect(() =>
      buildComposeAppHtml({ ...GMAIL_CONFIG, fields: { cc: true } as unknown as ComposeAppConfig['fields'] }),
    ).toThrow(/fields/);
    expect(() =>
      buildComposeAppHtml({ ...GMAIL_CONFIG, deepLink: { kind: 'outlook' } as unknown as ComposeAppConfig['deepLink'] }),
    ).toThrow(/deepLink/);
  });
});

describe('buildComposeAppHtml — variant template runs end-to-end (happy-dom)', () => {
  it('loads, sends via the configured tool, and reaches the sent view without bcc/deep-link machinery', () => {
    const window = loadWindow(acmeHtml);

    // Structural: the omitted subsystems are genuinely absent from the DOM.
    expect(window.document.getElementById('ccRow')).toBeTruthy();
    expect(window.document.getElementById('toggleCcButton')).toBeTruthy();
    expect(window.document.getElementById('bccRow')).toBeNull();
    expect(window.document.getElementById('toggleBccButton')).toBeNull();
    expect(window.document.getElementById('openGmailButton')).toBeNull();

    // Boot handshake still runs.
    const methods = postedMessages(window).map((msg) => msg.method);
    expect(methods).toContain('mcp-app:ready');
    expect(methods).toContain('ui/initialize');

    // Fill the form and click Send (click, not submit — the host sandbox has no
    // allow-forms, so the click path is the only one that works in production).
    setFieldValue(window, 'toInput', 'jane@example.com');
    setFieldValue(window, 'subjectInput', 'Quarterly update');
    setFieldValue(window, 'bodyInput', 'Numbers attached.');
    const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    sendButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const toolCall = postedMessages(window).find((msg) => msg.method === 'tools/call');
    expect(toolCall).toBeTruthy();
    expect(toolCall?.params?.name).toBe('send_acme_email');
    expect(toolCall?.params?.arguments).not.toHaveProperty('bcc');
    expect(toolCall?.params?.arguments?.to).toEqual(['jane@example.com']);

    // Host replies success: collapses to the sent summary; reopen shows the
    // read-only sent view.
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', id: toolCall?.id, result: {} } }));
    expect(isHidden(window, 'collapsedState')).toBe(false);
    const reopenButton = window.document.getElementById('reopenButton') as unknown as HTMLButtonElement;
    reopenButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(isHidden(window, 'sentView')).toBe(false);
    expect(isHidden(window, 'composeForm')).toBe(true);
  });
});
