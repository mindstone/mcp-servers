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

// Gmail plus the blocked-send Gmail escape hatch. Only Gmail-backed connectors
// enable this (the host allowlists mail.google.com); the assertions below pin
// its gated markup, the conservative detector, and the URL-length degradation.
const BLOCKED_CONFIG: ComposeAppConfig = {
  ...GMAIL_CONFIG,
  blockedSendFallback: { kind: 'gmail-compose' },
};

const gmailHtml = buildComposeAppHtml(GMAIL_CONFIG);
const acmeHtml = buildComposeAppHtml(ACME_CONFIG);
const blockedHtml = buildComposeAppHtml(BLOCKED_CONFIG);

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

// Fill the form, click Send, then reply from the "host" with a JSON-RPC error
// carrying `message` (and, when `errorData` is given, a structured `error.data`
// object as newer hosts forward it). Returns the window so callers can assert
// the resulting UI.
function sendThenReplyError(
  html: string,
  message: string,
  fields?: { to?: string; subject?: string; body?: string },
  errorData?: Record<string, unknown>,
): Window {
  const window = loadWindow(html);
  setFieldValue(window, 'toInput', fields?.to ?? 'jane@example.com');
  setFieldValue(window, 'subjectInput', fields?.subject ?? 'Quarterly update');
  setFieldValue(window, 'bodyInput', fields?.body ?? 'Numbers attached.');
  const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
  sendButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
  const toolCall = postedMessages(window).find((msg) => msg.method === 'tools/call');
  expect(toolCall).toBeTruthy();
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: toolCall?.id,
        error:
          errorData === undefined
            ? { code: -32000, message }
            : { code: -32000, message, data: errorData },
      },
    }),
  );
  return window;
}

// The two error strings we care about, as the host actually relays them: the
// numeric -33008 survives in the message text even though the host flattens the
// JSON-RPC code to -32000.
const USER_DISABLED_ERROR =
  "MCP error -33008: Tool 'send_workspace_email' is disabled by user preference. Re-enable it in Settings to use.. This tool has been blocked by the security policy.";
// Same shape, but admin-disabled / generic security — must NOT trigger the fallback.
const ADMIN_DISABLED_ERROR =
  "MCP error -33008: Tool 'send_workspace_email' is disabled by your organization. This tool has been blocked by the security policy.";
const NETWORK_ERROR = 'Network request failed. Please try again.';
const GENERIC_SECURITY_ERROR = 'This tool has been blocked by the security policy.';

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

describe('buildComposeAppHtml — blocked-send Gmail escape hatch (gating)', () => {
  it('inlines the escape hatch only when blockedSendFallback is gmail-compose', () => {
    for (const marker of [
      'id="blockedBox"',
      'id="openComposeButton"',
      'function isUserDisabledSendError',
      'function buildGmailComposeUrl',
      'function showBlockedSend',
      'var GMAIL_COMPOSE_MAX_URL = 8000;',
      'var blockedReason = data.error.data && data.error.data.reason;',
    ]) {
      expect(blockedHtml).toContain(marker);
      // Absent from the historical output (byte-parity for connectors that omit it).
      expect(gmailHtml).not.toContain(marker);
    }
  });

  it('is omitted when the field is absent or explicitly none', () => {
    expect(buildComposeAppHtml({ ...GMAIL_CONFIG, blockedSendFallback: { kind: 'none' } })).toBe(gmailHtml);
    // Absence and { kind: 'none' } are indistinguishable in the output.
    expect(buildComposeAppHtml(GMAIL_CONFIG)).toBe(gmailHtml);
  });

  it('rejects a malformed blockedSendFallback discriminator', () => {
    expect(() =>
      buildComposeAppHtml({
        ...GMAIL_CONFIG,
        blockedSendFallback: { kind: 'outlook-compose' } as unknown as ComposeAppConfig['blockedSendFallback'],
      }),
    ).toThrow(/blockedSendFallback/);
  });
});

describe('buildComposeAppHtml — blocked-send detector and Gmail URL (happy-dom)', () => {
  it('shows the escape hatch (not a retryable error) when the user disabled the send tool', () => {
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR);

    expect(isHidden(window, 'blockedBox')).toBe(false);
    expect(isHidden(window, 'errorBox')).toBe(true);
    const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.title).toContain('turned off in your settings');
  });

  it('treats admin-disabled, generic-security, and transport failures as ordinary errors', () => {
    for (const message of [ADMIN_DISABLED_ERROR, GENERIC_SECURITY_ERROR, NETWORK_ERROR]) {
      const window = sendThenReplyError(blockedHtml, message);
      expect(isHidden(window, 'blockedBox')).toBe(true);
      expect(isHidden(window, 'errorBox')).toBe(false);
      // Send stays available so the user can retry.
      const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    }
  });

  it("shows the escape hatch on structured reason 'user-disabled' even when the message would not text-match", () => {
    // A newer host forwards the closed discriminator but flattens the message
    // to something the legacy detector cannot recognise.
    const window = sendThenReplyError(blockedHtml, 'Tool call failed', undefined, {
      reason: 'user-disabled',
    });

    expect(isHidden(window, 'blockedBox')).toBe(false);
    expect(isHidden(window, 'errorBox')).toBe(true);
    const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
  });

  it('keeps admin-disabled and security-policy structured reasons as ordinary errors', () => {
    for (const reason of ['admin-disabled', 'security-policy']) {
      const window = sendThenReplyError(blockedHtml, 'Tool call failed', undefined, { reason });
      expect(isHidden(window, 'blockedBox')).toBe(true);
      expect(isHidden(window, 'errorBox')).toBe(false);
      const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
      expect(sendButton.disabled).toBe(false);
    }
  });

  it('ignores unrecognised or malformed error.data shapes and falls back to text-matching', () => {
    // Unknown reason with a non-matching message → ordinary error.
    const unknownReason = sendThenReplyError(blockedHtml, 'Tool call failed', undefined, {
      reason: 'totally-new-kind',
    });
    expect(isHidden(unknownReason, 'blockedBox')).toBe(true);
    expect(isHidden(unknownReason, 'errorBox')).toBe(false);

    // Malformed data alongside a legacy user-disabled message → the text
    // fallback still opens the escape hatch.
    const malformedData = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR, undefined, {
      unrelated: true,
    });
    expect(isHidden(malformedData, 'blockedBox')).toBe(false);
    expect(isHidden(malformedData, 'errorBox')).toBe(true);
  });

  it('opens a prefilled mail.google.com compose window via the host bridge', () => {
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR, {
      to: 'jane@example.com',
      subject: 'Q3 numbers',
      body: 'Attached.',
    });
    const openComposeButton = window.document.getElementById('openComposeButton') as unknown as HTMLButtonElement;
    openComposeButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const link = postedMessages(window).find((msg) => msg.method === 'ui/open-external-link');
    expect(link).toBeTruthy();
    const url = new URL(link?.params?.url as string);
    expect(url.origin + url.pathname).toBe('https://mail.google.com/mail/');
    expect(url.searchParams.get('view')).toBe('cm');
    expect(url.searchParams.get('to')).toBe('jane@example.com');
    expect(url.searchParams.get('su')).toBe('Q3 numbers');
    expect(url.searchParams.get('body')).toBe('Attached.');
  });

  it('carries edits made after the block into the Gmail compose URL', () => {
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR);
    // User edits the draft after seeing the escape hatch.
    setFieldValue(window, 'toInput', 'edited@example.com');
    setFieldValue(window, 'bodyInput', 'Rewritten body.');
    const openComposeButton = window.document.getElementById('openComposeButton') as unknown as HTMLButtonElement;
    openComposeButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const link = postedMessages(window)
      .reverse()
      .find((msg) => msg.method === 'ui/open-external-link');
    const url = new URL(link?.params?.url as string);
    expect(url.searchParams.get('to')).toBe('edited@example.com');
    expect(url.searchParams.get('body')).toBe('Rewritten body.');
  });

  it('round-trips multiple comma-separated recipients through the URL', () => {
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR, {
      to: 'ann@example.com, ben@example.com',
    });
    const openComposeButton = window.document.getElementById('openComposeButton') as unknown as HTMLButtonElement;
    openComposeButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const link = postedMessages(window).find((msg) => msg.method === 'ui/open-external-link');
    const url = new URL(link?.params?.url as string);
    // URLSearchParams encodes the joining comma as %2C; the decoded value must
    // be the comma-separated list Gmail expects.
    expect(url.searchParams.get('to')).toBe('ann@example.com,ben@example.com');
  });

  it('refuses to open (and says so) when even the no-body URL is too long', () => {
    // Far more recipients than a Gmail compose URL can carry, so dropping the
    // body still leaves it over the cap.
    const manyRecipients = Array.from({ length: 300 }, (_, i) => `recipient.number.${i}@example.com`).join(', ');
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR, { to: manyRecipients });
    const openComposeButton = window.document.getElementById('openComposeButton') as unknown as HTMLButtonElement;
    openComposeButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    // No link is posted — we don't hand Gmail a URL it will silently reject.
    expect(postedMessages(window).some((msg) => msg.method === 'ui/open-external-link')).toBe(false);
    const blockedText = window.document.getElementById('blockedText');
    // Copy is cause-agnostic (recipients OR an oversized subject can overflow).
    expect((blockedText as unknown as HTMLElement).textContent).toContain('too large to open in Gmail');
  });

  it('degrades to recipients + subject only (no body) when the compose URL would be too long', () => {
    const window = sendThenReplyError(blockedHtml, USER_DISABLED_ERROR, {
      body: 'x'.repeat(9000),
    });
    const openComposeButton = window.document.getElementById('openComposeButton') as unknown as HTMLButtonElement;
    openComposeButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const link = postedMessages(window).find((msg) => msg.method === 'ui/open-external-link');
    const url = new URL(link?.params?.url as string);
    expect(url.searchParams.has('body')).toBe(false);
    expect(url.searchParams.get('su')).toBe('Quarterly update');
    // The user is told the body was dropped, not silently truncated.
    const blockedText = window.document.getElementById('blockedText');
    expect((blockedText as unknown as HTMLElement).textContent).toContain('Copy the message text');
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

describe('buildComposeAppHtml — R7 a11y hardening', () => {
  it('marks the error box as an assertive alert and the success box as a polite status', () => {
    expect(gmailHtml).toContain('<div id="errorBox" class="status error hidden" role="alert">');
    expect(gmailHtml).toContain(
      '<div id="successBox" class="status success hidden" role="status" aria-live="polite"></div>',
    );
  });

  it('gives the compose form an accessible name', () => {
    expect(gmailHtml).toContain('<form id="composeForm" class="card" novalidate aria-label="Compose email">');
  });

  it('exposes CC/BCC toggles as collapsed disclosure controls', () => {
    expect(gmailHtml).toContain('id="toggleCcButton"');
    expect(gmailHtml).toContain('aria-expanded="false"');
    expect(gmailHtml).toContain('aria-controls="ccRow"');
    expect(gmailHtml).toContain('aria-controls="bccRow"');
  });

  it('toggles aria-busy on Send across the send lifecycle', () => {
    const window = loadWindow(gmailHtml);
    const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    // Not busy before a send is in flight (attribute absent === not busy).
    expect(sendButton.getAttribute('aria-busy')).not.toBe('true');

    setFieldValue(window, 'toInput', 'jane@example.com');
    setFieldValue(window, 'subjectInput', 'Quarterly update');
    setFieldValue(window, 'bodyInput', 'Numbers attached.');
    sendButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(sendButton.getAttribute('aria-busy')).toBe('true');

    const toolCall = postedMessages(window).find((msg) => msg.method === 'tools/call');
    window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', id: toolCall?.id, result: {} } }));
    expect(sendButton.getAttribute('aria-busy')).toBe('false');
  });

  it('syncs aria-expanded when a disclosure toggle is clicked', () => {
    const window = loadWindow(gmailHtml);
    const toggle = window.document.getElementById('toggleCcButton') as unknown as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('buildComposeAppHtml — R7 postMessage honest scope', () => {
  function getFieldValue(window: Window, id: string): string {
    const el = window.document.getElementById(id) as unknown as HTMLInputElement | HTMLTextAreaElement;
    return el.value;
  }

  function dispatchToolResult(window: Window, structuredContent: Record<string, unknown>, source?: unknown): void {
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { method: 'ui/notifications/tool-result', params: { structuredContent } },
        // happy-dom honours the source init; a real cross-frame postMessage always
        // stamps it, so this simulates a foreign sender when set.
        ...(source !== undefined ? { source: source as Window } : {}),
      }),
    );
  }

  it('applies only the first tool-result prefill and ignores later re-posts', () => {
    const window = loadWindow(gmailHtml);
    dispatchToolResult(window, { to: ['first@example.com'], subject: 'First', body: 'First body' });
    expect(getFieldValue(window, 'toInput')).toBe('first@example.com');
    expect(getFieldValue(window, 'subjectInput')).toBe('First');

    // A second, well-formed prefill (e.g. a stray or hostile re-post) must NOT
    // silently overwrite what the user has already reviewed.
    dispatchToolResult(window, { to: ['second@example.com'], subject: 'Second', body: 'Second body' });
    expect(getFieldValue(window, 'toInput')).toBe('first@example.com');
    expect(getFieldValue(window, 'subjectInput')).toBe('First');
  });

  it('rejects a prefill from an identified non-parent sender', () => {
    const window = loadWindow(gmailHtml);
    const foreign = new Window({ url: 'https://attacker.example/' });
    // A message stamped with a source that is not our host frame is dropped...
    dispatchToolResult(window, { to: ['evil@example.com'], subject: 'Injected', body: 'x' }, foreign);
    expect(getFieldValue(window, 'toInput')).toBe('');
    expect(getFieldValue(window, 'subjectInput')).toBe('');
    foreign.close();

    // ...while a same-context (null-source) dispatch — which cannot be forged
    // from outside the iframe — is still accepted.
    dispatchToolResult(window, { to: ['ok@example.com'], subject: 'Legit', body: 'y' });
    expect(getFieldValue(window, 'toInput')).toBe('ok@example.com');
  });

  it('accepts a prefill stamped with the host parent as source', () => {
    // The exact production acceptance path: the host reposts the tool-result via
    // iframe.contentWindow.postMessage(...), so the listener sees event.source ===
    // window.parent. The script runs in its own eval realm, so we capture THAT
    // realm's window.parent (the object the guard actually compares against) and
    // stamp the message with it — the null-source test above only covers the
    // short-circuit branch, this covers the identity-match branch.
    const window = loadWindow(gmailHtml);
    window.eval('globalThis.__composeHostParent = window.parent;');
    const hostParent = (window as unknown as { __composeHostParent: Window }).__composeHostParent;
    dispatchToolResult(
      window,
      { to: ['host@example.com'], subject: 'From host', body: 'Reposted on ready' },
      hostParent,
    );
    expect(getFieldValue(window, 'toInput')).toBe('host@example.com');
    expect(getFieldValue(window, 'subjectInput')).toBe('From host');
  });
});
