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

  const form = window.document.getElementById('composeForm') as unknown as HTMLFormElement;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);

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

  it('a matching reply before the timeout shows success and neutralizes the timeout', () => {
    composeWindow = loadComposeEmailWindow();
    const { fireTimeout, requestId } = submitAndCaptureTimeout(composeWindow);

    dispatchToolReply(composeWindow, requestId, { result: { ok: true } });

    expect(isHidden(composeWindow, 'successBox')).toBe(false);
    expect(isHidden(composeWindow, 'unknownBox')).toBe(true);

    // A late timeout callback (e.g. a stale timer that wasn't cancelled) must be
    // a no-op now that the request resolved — it must not overwrite success with
    // the unknown state.
    fireTimeout();
    expect(isHidden(composeWindow, 'unknownBox')).toBe(true);
    expect(isHidden(composeWindow, 'successBox')).toBe(false);
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
