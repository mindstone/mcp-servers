import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { COMPOSE_EMAIL_HTML } from '../src/resources/compose-email-template.js';

let composeWindow: Window | undefined;

function loadComposeEmailWindow(): Window {
  const window = new Window({ url: 'https://example.com/compose-email.html' });
  window.document.write(COMPOSE_EMAIL_HTML);
  window.parent.postMessage = vi.fn();
  Object.defineProperty(window.console, 'warn', {
    value: vi.fn(),
    configurable: true,
  });

  const script = window.document.querySelector('script');
  expect(script?.textContent).toBeTruthy();
  window.eval(script?.textContent ?? '');

  return window;
}

function getFieldValue(window: Window, id: string): string {
  const element = window.document.getElementById(id);
  expect(element).toBeTruthy();
  return (element as unknown as HTMLInputElement | HTMLTextAreaElement).value;
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

function getFromValue(window: Window): string {
  const element = window.document.getElementById('fromValue');
  expect(element).toBeTruthy();
  return (element as unknown as HTMLElement).textContent ?? '';
}

function getFromHelper(window: Window): string {
  const element = window.document.getElementById('fromHelper');
  expect(element).toBeTruthy();
  return (element as unknown as HTMLElement).textContent ?? '';
}

function getText(window: Window, id: string): string {
  const element = window.document.getElementById(id);
  expect(element).toBeTruthy();
  return (element as unknown as HTMLElement).textContent ?? '';
}

/**
 * The most recent `ui/open-external-link` request the iframe posted to its host
 * parent (the sandbox can't open URLs itself), or undefined if none was posted.
 */
function lastOpenExternalLink(window: Window): { url?: unknown } | undefined {
  const postMessage = window.parent.postMessage as unknown as {
    mock: { calls: Array<[{ method?: string; params?: { url?: unknown } }]> };
  };
  const calls = postMessage.mock.calls
    .map((call) => call[0])
    .filter((msg) => msg?.method === 'ui/open-external-link');
  return calls.length > 0 ? (calls[calls.length - 1].params as { url?: unknown }) : undefined;
}

/**
 * Fill the form's required fields and submit, capturing the send-timeout
 * callback so the test can fire it deterministically (happy-dom window timers
 * are not driven by vitest fake timers). Returns the captured timeout fn and the
 * id the iframe posted on its tools/call so a matching reply can be simulated.
 */
function submitAndCaptureTimeout(window: Window): { fireTimeout: () => void; requestId: unknown } {
  setFieldValue(window, 'toInput', 'user@example.com');
  setFieldValue(window, 'subjectInput', 'Subject');
  setFieldValue(window, 'bodyInput', 'Hello there');

  let captured: (() => void) | null = null;
  (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
    if (ms === 75000) {
      captured = fn;
    }
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  // Click the Send button — the real user path. The button is type="button"
  // with a click handler because the Rebel host sandboxes this iframe without
  // "allow-forms", so native form submission is blocked before the submit event
  // fires (REBEL send-button silent no-op). Driving the click here keeps the
  // test honest against the sandbox the connector actually runs in.
  const sendButton = window.document.getElementById('sendButton') as unknown as HTMLButtonElement;
  sendButton.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

  const postMessage = window.parent.postMessage as unknown as { mock: { calls: Array<[{ method?: string; id?: unknown }]> } };
  const toolCall = postMessage.mock.calls.map((call) => call[0]).find((msg) => msg?.method === 'tools/call');
  expect(toolCall).toBeTruthy();
  expect(captured).toBeTypeOf('function');

  return { fireTimeout: () => (captured as unknown as () => void)(), requestId: toolCall?.id };
}

function dispatchToolReply(window: Window, id: unknown, payload: { result?: unknown; error?: unknown }): void {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { jsonrpc: '2.0', id, ...payload },
  }));
}

function dispatchToolResult(window: Window, params: Record<string, unknown>): void {
  window.dispatchEvent(
    new window.MessageEvent('message', {
      data: {
        method: 'ui/notifications/tool-result',
        params,
      },
    }),
  );
}

function expectNoConsoleWarnings(window: Window): void {
  expect(window.console.warn).not.toHaveBeenCalled();
}

function prefillExistingDraft(window: Window): void {
  dispatchToolResult(window, {
    structuredContent: {
      to: ['existing@example.com'],
      cc: ['existing-copy@example.com'],
      bcc: ['existing-blind@example.com'],
      subject: 'Existing draft',
      body: 'Existing body',
    },
  });
}

function createUseToolEnvelopeText(structuredContent: Record<string, unknown>): string {
  const argsUsed = {
    to: structuredContent.to,
    cc: structuredContent.cc,
    bcc: structuredContent.bcc,
    subject: structuredContent.subject,
    body: structuredContent.body,
  };
  const result = {
    content: [
      {
        type: 'text',
        text: `Drafting email to ${Array.isArray(structuredContent.to) ? structuredContent.to.join(', ') : '(no recipients)'} with subject "${typeof structuredContent.subject === 'string' ? structuredContent.subject : ''}"\n\n${JSON.stringify(structuredContent)}\n\n[View: ui://google-workspace/compose-email]`,
      },
    ],
    _meta: {
      ui: {
        resourceUri: 'ui://google-workspace/compose-email',
      },
    },
    structuredContent,
  };
  return createUseToolEnvelopeFromResult(result, argsUsed);
}

function createUseToolEnvelopeFromResult(
  result: unknown,
  argsUsed: Record<string, unknown> = {},
): string {
  const envelopeWithoutOutputChars = {
    package_id: 'google_workspace_demo',
    tool_id: 'compose_workspace_email',
    args_used: argsUsed,
    result,
    telemetry: {
      duration_ms: 12,
      status: 'ok',
    },
  };
  const outputChars = JSON.stringify(envelopeWithoutOutputChars, null, 2).length;

  return JSON.stringify({
    ...envelopeWithoutOutputChars,
    telemetry: {
      ...envelopeWithoutOutputChars.telemetry,
      output_chars: outputChars,
    },
  }, null, 2);
}

describe('compose email iframe template', () => {
  afterEach(() => {
    composeWindow?.close();
    composeWindow = undefined;
  });

  it('renders Send as a type="button" (not a form submit) so the allow-forms-less sandbox cannot block it', () => {
    composeWindow = loadComposeEmailWindow();

    const sendButton = composeWindow.document.getElementById('sendButton');
    expect(sendButton).toBeTruthy();
    // A submit button would trigger native form submission, which the Rebel host
    // sandbox ("allow-scripts" only, no "allow-forms") blocks BEFORE the submit
    // event fires — the send then silently no-ops. Must stay a plain button.
    expect((sendButton as unknown as HTMLButtonElement).getAttribute('type')).toBe('button');
  });

  it('sends via a click on the Send button (the path that survives the sandbox)', () => {
    composeWindow = loadComposeEmailWindow();

    setFieldValue(composeWindow, 'toInput', 'user@example.com');
    setFieldValue(composeWindow, 'subjectInput', 'Subject');
    setFieldValue(composeWindow, 'bodyInput', 'Hello there');

    const sendButton = composeWindow.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    sendButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const postMessage = composeWindow.parent.postMessage as unknown as {
      mock: { calls: Array<[{ method?: string; params?: { name?: string } }]> };
    };
    const toolCall = postMessage.mock.calls
      .map((call) => call[0])
      .find((msg) => msg?.method === 'tools/call');
    expect(toolCall).toBeTruthy();
    expect(toolCall?.params?.name).toBe('send_workspace_email');
    expectNoConsoleWarnings(composeWindow);
  });

  it('does not double-send if both click and submit fire (allow-forms host); the sending guard holds', () => {
    composeWindow = loadComposeEmailWindow();

    setFieldValue(composeWindow, 'toInput', 'user@example.com');
    setFieldValue(composeWindow, 'subjectInput', 'Subject');
    setFieldValue(composeWindow, 'bodyInput', 'Hello there');

    // Simulate a host that DOES grant allow-forms: the click handler fires, then
    // native submission also dispatches submit. sendPayload sets `sending`
    // synchronously, so the second path must return at `if (sending) return`.
    const sendButton = composeWindow.document.getElementById('sendButton') as unknown as HTMLButtonElement;
    const form = composeWindow.document.getElementById('composeForm') as unknown as HTMLFormElement;
    sendButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    form.dispatchEvent(new composeWindow.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);

    const postMessage = composeWindow.parent.postMessage as unknown as {
      mock: { calls: Array<[{ method?: string }]> };
    };
    const toolCalls = postMessage.mock.calls
      .map((call) => call[0])
      .filter((msg) => msg?.method === 'tools/call');
    expect(toolCalls).toHaveLength(1);
  });

  it('pre-fills fields from production-shaped ui/notifications/tool-result structuredContent', () => {
    composeWindow = loadComposeEmailWindow();

    dispatchToolResult(composeWindow, {
      structuredContent: {
        to: ['a@example.com'],
        cc: ['c@example.com'],
        bcc: ['b@example.com'],
        subject: 'Hello',
        body: 'Body text',
      },
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('a@example.com');
    expect(getFieldValue(composeWindow, 'ccInput')).toBe('c@example.com');
    expect(getFieldValue(composeWindow, 'bccInput')).toBe('b@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Hello');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Body text');
    expectNoConsoleWarnings(composeWindow);
  });

  it('normalizes object-shaped recipient entries defensively', () => {
    composeWindow = loadComposeEmailWindow();

    dispatchToolResult(composeWindow, {
      structuredContent: {
        to: [{ email: 'a@example.com', name: 'A' }],
        subject: 'Hello',
        body: 'Body text',
      },
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('A <a@example.com>');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Hello');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Body text');
    expectNoConsoleWarnings(composeWindow);
  });

  it('renders the From row populated from canonical structuredContent email', () => {
    composeWindow = loadComposeEmailWindow();

    dispatchToolResult(composeWindow, {
      structuredContent: {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'Body text',
        email: 'greg@mindstone.com',
      },
    });

    expect(getFromValue(composeWindow)).toBe('greg@mindstone.com');
    expect(isHidden(composeWindow, 'fromHelper')).toBe(true);
    expect(getFromHelper(composeWindow)).toBe('');
    expectNoConsoleWarnings(composeWindow);
  });

  it('renders the From row empty-state when structuredContent has no email', () => {
    composeWindow = loadComposeEmailWindow();

    dispatchToolResult(composeWindow, {
      structuredContent: {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'Body text',
      },
    });

    expect(getFromValue(composeWindow)).toBe('Account not shown');
    expect(isHidden(composeWindow, 'fromHelper')).toBe(false);
    expect(getFromHelper(composeWindow)).toContain('Rebel could not confirm the sending account');
    expectNoConsoleWarnings(composeWindow);
  });

  it('renders a hostile From value as inert text (no markup injection)', () => {
    composeWindow = loadComposeEmailWindow();

    const hostile = '<img src=x onerror="alert(1)">';
    dispatchToolResult(composeWindow, {
      structuredContent: {
        to: ['a@example.com'],
        subject: 'Hello',
        body: 'Body text',
        email: hostile,
      },
    });

    const fromEl = composeWindow.document.getElementById('fromValue');
    // The raw string survives verbatim as text — proving it went through textContent, not innerHTML.
    expect(getFromValue(composeWindow)).toBe(hostile);
    // No element was parsed out of the payload (an innerHTML sink would have created an <img>).
    expect(fromEl?.querySelector('img')).toBeNull();
    expect((fromEl as unknown as HTMLElement).children.length).toBe(0);
    expectNoConsoleWarnings(composeWindow);
  });

  it('pre-fills fields from migration envelope text when structuredContent is absent', () => {
    composeWindow = loadComposeEmailWindow();
    const envelopeText = createUseToolEnvelopeText({
      to: ['legacy@example.com'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      subject: 'Legacy replay',
      body: 'Recovered from inner envelope',
      email: 'sender@example.com',
    });
    const envelope = JSON.parse(envelopeText) as Record<string, unknown>;
    const telemetry = envelope.telemetry as Record<string, unknown>;

    expect(Object.keys(envelope)).toEqual(['package_id', 'tool_id', 'args_used', 'result', 'telemetry']);
    expect(envelope.args_used).toEqual({
      to: ['legacy@example.com'],
      cc: ['copy@example.com'],
      bcc: ['blind@example.com'],
      subject: 'Legacy replay',
      body: 'Recovered from inner envelope',
    });
    expect(telemetry).toEqual({
      duration_ms: 12,
      status: 'ok',
      output_chars: expect.any(Number),
    });

    dispatchToolResult(composeWindow, {
      text: envelopeText,
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('legacy@example.com');
    expect(getFieldValue(composeWindow, 'ccInput')).toBe('copy@example.com');
    expect(getFieldValue(composeWindow, 'bccInput')).toBe('blind@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Legacy replay');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Recovered from inner envelope');
    expect(getFromValue(composeWindow)).toBe('sender@example.com');
    expect(isHidden(composeWindow, 'fromHelper')).toBe(true);
    expectNoConsoleWarnings(composeWindow);
  });

  it('pre-fills fields from migration envelope text in a content array', () => {
    composeWindow = loadComposeEmailWindow();

    dispatchToolResult(composeWindow, {
      content: [
        {
          type: 'text',
          text: createUseToolEnvelopeText({
            to: ['array@example.com'],
            subject: 'Content array replay',
            body: 'Recovered from content[0].text',
          }),
        },
      ],
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('array@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Content array replay');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Recovered from content[0].text');
    expectNoConsoleWarnings(composeWindow);
  });

  it('leaves fields unchanged when no structuredContent or envelope text is present', () => {
    composeWindow = loadComposeEmailWindow();

    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      content: [],
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'ccInput')).toBe('existing-copy@example.com');
    expect(getFieldValue(composeWindow, 'bccInput')).toBe('existing-blind@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expectNoConsoleWarnings(composeWindow);
  });

  it('does not pre-fill from plain JSON fragments without a super-mcp result wrapper', () => {
    composeWindow = loadComposeEmailWindow();

    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      text: JSON.stringify({
        to: ['plain-json@example.com'],
        subject: 'Plain JSON',
        body: 'This must not be regex-sniffed into a draft.',
      }),
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expectNoConsoleWarnings(composeWindow);
  });

  it('leaves fields unchanged and warns when likely-envelope JSON is malformed', () => {
    composeWindow = loadComposeEmailWindow();
    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      text: '{"package_id":"google_workspace_demo","tool_id":"compose_workspace_email","result":',
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expect(composeWindow.console.warn).toHaveBeenCalledTimes(1);
    expect(composeWindow.console.warn).toHaveBeenCalledWith(
      '[compose-email] Migration shim: JSON.parse failed on likely super-mcp envelope; pre-fill skipped',
    );
  });

  it('leaves fields unchanged when parsed envelope result lacks structuredContent', () => {
    composeWindow = loadComposeEmailWindow();
    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      text: createUseToolEnvelopeFromResult({
        content: [
          {
            type: 'text',
            text: '[View: ui://google-workspace/compose-email]',
          },
        ],
        _meta: {
          ui: {
            resourceUri: 'ui://google-workspace/compose-email',
          },
        },
      }),
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expectNoConsoleWarnings(composeWindow);
  });

  it('leaves fields unchanged when parsed envelope structuredContent is not an object', () => {
    composeWindow = loadComposeEmailWindow();
    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      text: createUseToolEnvelopeFromResult({
        content: [
          {
            type: 'text',
            text: '[View: ui://google-workspace/compose-email]',
          },
        ],
        structuredContent: 'unexpected',
      }),
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expectNoConsoleWarnings(composeWindow);
  });

  it('shows an unknown-outcome state (not failure, not success) when the send gets no reply', () => {
    composeWindow = loadComposeEmailWindow();
    const { fireTimeout } = submitAndCaptureTimeout(composeWindow);

    // While in flight, the form is locked.
    expect((composeWindow.document.getElementById('sendButton') as unknown as HTMLButtonElement).disabled).toBe(true);

    // The reply never arrives; the bounded timeout fires.
    fireTimeout();

    // The button recovers (no permanent silent-stuck), and we surface an honest
    // "outcome unknown" state — NOT an error verdict (which would invite a
    // duplicate send) and NOT success.
    expect(isHidden(composeWindow, 'unknownBox')).toBe(false);
    expect(composeWindow.document.getElementById('unknownTitle')?.textContent).toBe('Not sure if this sent.');
    expect(composeWindow.document.getElementById('unknownText')?.textContent ?? '').toContain('Sent folder');
    expect(isHidden(composeWindow, 'errorBox')).toBe(true);
    expect(isHidden(composeWindow, 'successBox')).toBe(true);
    expect((composeWindow.document.getElementById('sendButton') as unknown as HTMLButtonElement).disabled).toBe(false);
    expectNoConsoleWarnings(composeWindow);
  });

  it('a matching reply before the timeout collapses to a sent summary and neutralizes the timeout', () => {
    composeWindow = loadComposeEmailWindow();
    const { fireTimeout, requestId } = submitAndCaptureTimeout(composeWindow);

    dispatchToolReply(composeWindow, requestId, { result: { ok: true } });

    // After a send we default to the collapsed summary bar (not the old
    // success banner). The composed message is preserved, not discarded.
    expect(isHidden(composeWindow, 'collapsedState')).toBe(false);
    expect(isHidden(composeWindow, 'sentView')).toBe(true);
    expect(isHidden(composeWindow, 'composeForm')).toBe(true);
    expect(getText(composeWindow, 'collapsedMessage')).toContain('Email sent');
    expect(isHidden(composeWindow, 'unknownBox')).toBe(true);

    // A late timeout callback (e.g. a stale timer that wasn't cancelled) must be
    // a no-op now that the request resolved — it must not overwrite the sent
    // state with the unknown state.
    fireTimeout();
    expect(isHidden(composeWindow, 'unknownBox')).toBe(true);
    expect(isHidden(composeWindow, 'collapsedState')).toBe(false);
    expectNoConsoleWarnings(composeWindow);
  });

  it('preserves the composed message in a read-only sent view that Reopen restores (never the editable form)', () => {
    composeWindow = loadComposeEmailWindow();
    const { requestId } = submitAndCaptureTimeout(composeWindow);

    dispatchToolReply(composeWindow, requestId, { result: { ok: true } });

    // Reopen after a send restores the read-only sent view — NOT the editable
    // form — so the user can re-read what went out with zero risk of a
    // duplicate send.
    const reopenButton = composeWindow.document.getElementById('reopenButton') as unknown as HTMLButtonElement;
    reopenButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    expect(isHidden(composeWindow, 'sentView')).toBe(false);
    expect(isHidden(composeWindow, 'composeForm')).toBe(true);
    expect(isHidden(composeWindow, 'collapsedState')).toBe(true);

    // The message the user sent is intact in the read-only view.
    expect(getText(composeWindow, 'sentTo')).toBe('user@example.com');
    expect(getText(composeWindow, 'sentSubject')).toBe('Subject');
    expect(getText(composeWindow, 'sentBody')).toBe('Hello there');
    // A "when sent" timestamp is shown.
    expect(getText(composeWindow, 'sentTimestamp')).toContain('Sent');

    // Collapse from the sent view returns to the summary bar (still not the form).
    const sentCollapseButton = composeWindow.document.getElementById('sentCollapseButton') as unknown as HTMLButtonElement;
    sentCollapseButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);
    expect(isHidden(composeWindow, 'collapsedState')).toBe(false);
    expect(isHidden(composeWindow, 'composeForm')).toBe(true);
    expectNoConsoleWarnings(composeWindow);
  });

  it('builds an Open-in-Gmail link from the send reply and asks the host to open it (the sandbox cannot)', () => {
    composeWindow = loadComposeEmailWindow();
    const { requestId } = submitAndCaptureTimeout(composeWindow);

    // super-mcp hoists the connector's structuredContent onto the outer result
    // block, so the ids arrive as result.structuredContent.
    dispatchToolReply(composeWindow, requestId, {
      result: { structuredContent: { messageId: 'msg-123', threadId: 'thread-abc' } },
    });

    const reopenButton = composeWindow.document.getElementById('reopenButton') as unknown as HTMLButtonElement;
    reopenButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    expect(isHidden(composeWindow, 'openGmailButton')).toBe(false);

    const openGmailButton = composeWindow.document.getElementById('openGmailButton') as unknown as HTMLButtonElement;
    openGmailButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    const request = lastOpenExternalLink(composeWindow);
    expect(request).toBeTruthy();
    // threadId wins over messageId; the account defaults to /u/0 when unknown.
    expect(request?.url).toBe('https://mail.google.com/mail/u/0/#all/thread-abc');
    expectNoConsoleWarnings(composeWindow);
  });

  it('hides the Open-in-Gmail button when the send reply carries no message identifiers', () => {
    composeWindow = loadComposeEmailWindow();
    const { requestId } = submitAndCaptureTimeout(composeWindow);

    dispatchToolReply(composeWindow, requestId, { result: { ok: true } });

    const reopenButton = composeWindow.document.getElementById('reopenButton') as unknown as HTMLButtonElement;
    reopenButton.dispatchEvent(new composeWindow.Event('click', { bubbles: true, cancelable: true }) as unknown as Event);

    expect(isHidden(composeWindow, 'sentView')).toBe(false);
    expect(isHidden(composeWindow, 'openGmailButton')).toBe(true);
    expect(lastOpenExternalLink(composeWindow)).toBeUndefined();
    expectNoConsoleWarnings(composeWindow);
  });

  it('clears the unknown-outcome state when the user edits a field to resend', () => {
    composeWindow = loadComposeEmailWindow();
    const { fireTimeout } = submitAndCaptureTimeout(composeWindow);
    fireTimeout();
    expect(isHidden(composeWindow, 'unknownBox')).toBe(false);

    setFieldValue(composeWindow, 'bodyInput', 'Hello there, edited');

    expect(isHidden(composeWindow, 'unknownBox')).toBe(true);
    expectNoConsoleWarnings(composeWindow);
  });

  it('keeps top-level text precedence over content array envelope fallback', () => {
    composeWindow = loadComposeEmailWindow();
    prefillExistingDraft(composeWindow);

    dispatchToolResult(composeWindow, {
      // Current precedence is intentional: `params.text` is the selected source.
      // If it is a non-envelope summary, the shim does not continue on to
      // `params.content[].text`.
      text: 'Email sent',
      content: [
        {
          type: 'text',
          text: createUseToolEnvelopeText({
            to: ['content-envelope@example.com'],
            subject: 'Content envelope',
            body: 'Should not win over params.text',
          }),
        },
      ],
    });

    expect(getFieldValue(composeWindow, 'toInput')).toBe('existing@example.com');
    expect(getFieldValue(composeWindow, 'subjectInput')).toBe('Existing draft');
    expect(getFieldValue(composeWindow, 'bodyInput')).toBe('Existing body');
    expectNoConsoleWarnings(composeWindow);
  });
});
