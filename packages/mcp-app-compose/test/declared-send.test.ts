import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import * as compose from '../src/index.js';
import type { ComposeAppConfig } from '../src/types.js';

const windows: Window[] = [];
afterEach(() => windows.splice(0).forEach(window => window.close()));

function mount(config: ComposeAppConfig, outcome?: Record<string, unknown>) {
  const window = new Window();
  windows.push(window);
  Object.assign(window, { __MCP_HOST_CONTEXT__: { cardOutcome: outcome } });
  window.document.write(compose.buildComposeAppHtml(config));
  window.parent.postMessage = vi.fn();
  window.eval(window.document.querySelector('script')!.textContent!);
  return window;
}

function notify(window: Window, method: string, params: unknown) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { method, params }, source: window.eval('window.parent'),
  }));
}

const cases = [
  { mode: 'email', sendToolName: 'send_workspace_email', fields: { cc: true, bcc: true },
    draft: { to: [' ada@example.com ', 'grace@example.com'], cc: [' cc@example.com '], bcc: [], subject: '  Update  ', body: '  indented report\n', email: 'sender@example.com' },
    args: { to: ['ada@example.com', 'grace@example.com'], cc: ['cc@example.com'], bcc: [], subject: '  Update  ', body: '  indented report\n', email: 'sender@example.com' } },
  { mode: 'email', sendToolName: 'send_acme_email', fields: { cc: false, bcc: false },
    draft: { to: ['ada@example.com'], subject: 'Hi', body: ' Body\n' },
    args: { to: ['ada@example.com'], subject: 'Hi', body: ' Body\n' } },
  { mode: 'slack', sendToolName: 'post_slack_message', fields: { cc: false, bcc: false },
    draft: { target: '#general', text: '  indented report\n' }, args: { channel: '#general', text: '  indented report\n' } },
  { mode: 'slack', sendToolName: 'post_slack_message', fields: { cc: false, bcc: false },
    draft: { target: 'C123', text: 'Hello' }, args: { channel: 'C123', text: 'Hello' } },
  { mode: 'slack', sendToolName: 'post_slack_message', fields: { cc: false, bcc: false },
    draft: { target: 'U123', recipient_label: '<untrusted-content source="slack:user-profile">Test User</untrusted-content>', text: 'Hello' }, args: { channel: 'U123', text: 'Hello' } },
  { mode: 'teams', sendToolName: 'send_chat_message', fields: { cc: false, bcc: false },
    draft: { target: ' chat-1 ', text: '  indented report\n' }, args: { chatId: 'chat-1', content: '  indented report\n' } },
] satisfies Array<{ mode: 'email' | 'slack' | 'teams'; sendToolName: string; fields: { cc: boolean; bcc: boolean }; draft: Record<string, unknown>; args: Record<string, unknown> }>;

describe('shared declared send', () => {
  it.each(cases)('preserves the existing $mode click arguments ($sendToolName, $draft.target)', ({ mode, sendToolName, fields, draft, args }) => {
    const config = { resourceUri: 'ui://acme/compose', fromMissingHelperText: 'Account not shown.', mode, sendToolName, fields, deepLink: { kind: 'none' } } as const;
    const window = mount(config);
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    window.document.getElementById('sendButton')!.click();
    const call = vi.mocked(window.parent.postMessage).mock.calls.map(call => call[0]).find(message => message.method === 'tools/call');
    expect(call?.params.arguments).toEqual(args);
    expect(compose.buildSendArguments(mode, draft, config)).toEqual({ tool: sendToolName, arguments: args });
  });

  it('keeps the displayed account separate from an omitted send account', () => {
    const config = { resourceUri: 'ui://acme/compose', fromMissingHelperText: 'Account not shown.', sendToolName: 'send_workspace_email', fields: { cc: true, bcc: true }, deepLink: { kind: 'none' } } as const;
    const window = mount(config);
    const draft = { to: ['ada@example.com'], subject: 'Hi', body: ' Body\n', email: 'sender@example.com', sendEmail: null };
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    window.document.getElementById('sendButton')!.click();
    const call = vi.mocked(window.parent.postMessage).mock.calls.map(call => call[0]).find(message => message.method === 'tools/call');
    expect(window.document.getElementById('fromValue')!.textContent).toBe('sender@example.com');
    expect(call?.params.arguments).toEqual({ to: draft.to, cc: [], bcc: [], subject: draft.subject, body: draft.body });
    expect(compose.buildSendArguments('email', draft, config).arguments).toEqual(call?.params.arguments);
  });

  it.each(['email', 'slack', 'teams'] as const)('matches browser value sanitization for %s', mode => {
    // Chromium strips line breaks from inputs and uses LF in textareas.
    // happy-dom preserves textarea CR bytes, so test this independently of it.
    const options = { sendToolName: 'send', fields: { cc: true, bcc: true } };
    const draft = { to: ['ada@\r\nexample.com'], subject: 'First\r\nsecond', body: '  First\r\nsecond\rthird\n', target: 'chat-\r\n1', text: '  First\r\nsecond\rthird\n' };
    const args = compose.buildSendArguments(mode, draft, options).arguments;
    expect(args[mode === 'email' ? 'body' : mode === 'slack' ? 'text' : 'content']).toBe('  First\nsecond\nthird\n');
    if (mode === 'email') {
      expect(args.subject).toBe('Firstsecond');
      expect(args.to).toEqual(['ada@example.com']);
    } else {
      expect(args[mode === 'slack' ? 'channel' : 'chatId']).toBe('chat-1');
    }
  });

  it('omits a display-only account from the Microsoft Mail click', () => {
    const config = { resourceUri: 'ui://acme/compose', fromMissingHelperText: 'Account not shown.', sendToolName: 'send_email', fields: { cc: true, bcc: true }, includeAccount: false, deepLink: { kind: 'none' } } as const;
    const window = mount(config);
    const draft = { to: ['ada@example.com'], subject: 'Hi', body: ' Body\n', email: 'sender@example.com' };
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    window.document.getElementById('sendButton')!.click();
    const call = vi.mocked(window.parent.postMessage).mock.calls.map(call => call[0]).find(message => message.method === 'tools/call');
    expect(call?.params.arguments).toEqual({ to: draft.to, cc: [], bcc: [], subject: draft.subject, body: draft.body });
    expect(window.document.getElementById('fromValue')!.textContent).toBe('sender@example.com');
    expect(compose.buildSendArguments('email', draft, config).arguments).toEqual(call?.params.arguments);
  });
});

describe.each(cases.filter((value, index) => [0, 2, 5].includes(index)))('assistant attribution ($mode)', ({ mode, sendToolName, fields, draft }) => {
  const config = { resourceUri: 'ui://acme/compose', fromMissingHelperText: 'Account not shown.', mode, sendToolName, fields, deepLink: { kind: 'none' } } as const;
  const outcome = { outcome: 'sent', by: 'agent', at: Date.UTC(2026, 0, 2) };

  it.each(['initial', 'before-prefill', 'after-prefill'])('shows Sent by your assistant for an unedited draft (%s)', timing => {
    const window = mount(config, timing === 'initial' ? outcome : undefined);
    if (timing === 'before-prefill') notify(window, 'mcp-app:card-outcome', outcome);
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    if (timing === 'after-prefill') notify(window, 'mcp-app:card-outcome', outcome);
    expect(window.document.getElementById('collapsedMessage')!.textContent).toContain('Sent by your assistant');
    expect(window.document.getElementById('composeForm')!.classList.contains('hidden')).toBe(true);
  });

  it('keeps an edited version and its Send button live', () => {
    const window = mount(config);
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    const body = window.document.getElementById('bodyInput')! as unknown as HTMLTextAreaElement;
    body.value = 'My edited version\n';
    body.dispatchEvent(new window.Event('input'));
    notify(window, 'mcp-app:card-outcome', outcome);
    expect(window.document.getElementById('successBox')!.textContent).toBe('Your assistant sent the original version');
    expect(body.value).toBe('My edited version\n');
    expect(window.document.getElementById('composeForm')!.classList.contains('hidden')).toBe(false);
    expect(window.document.getElementById('sendButton')!.hasAttribute('disabled')).toBe(false);
    window.document.getElementById('sendButton')!.click();
    const call = vi.mocked(window.parent.postMessage).mock.calls.map(call => call[0]).find(message => message.method === 'tools/call');
    expect(call?.params.arguments[mode === 'email' ? 'body' : mode === 'teams' ? 'content' : 'text']).toBe('My edited version\n');
  });

  it('keeps the assistant-sent notice through Cancel and Reopen of an edited version', () => {
    const window = mount(config);
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    const body = window.document.getElementById('bodyInput')! as unknown as HTMLTextAreaElement;
    body.value = 'My edited version\n';
    body.dispatchEvent(new window.Event('input'));
    notify(window, 'mcp-app:card-outcome', outcome);
    window.document.getElementById('cancelButton')!.click();
    const collapsed = window.document.getElementById('collapsedMessage')!.textContent;
    expect(collapsed).toBe('Your assistant sent the original version. Your edits were not sent.');
    expect(collapsed).not.toContain('Nothing sent');
    window.document.getElementById('reopenButton')!.click();
    expect(window.document.getElementById('successBox')!.textContent).toBe('Your assistant sent the original version');
    expect(window.document.getElementById('successBox')!.classList.contains('hidden')).toBe(false);
    expect(body.value).toBe('My edited version\n');
  });

  it('preserves the person-sent treatment when attribution is absent', () => {
    const window = mount(config);
    notify(window, 'ui/notifications/tool-result', { structuredContent: draft });
    notify(window, 'mcp-app:card-outcome', { outcome: 'sent' });
    expect(window.document.getElementById('collapsedMessage')!.textContent).toBe(mode === 'email' ? 'Email sent.' : 'Message sent.');
    expect(window.document.getElementById('composeForm')!.classList.contains('hidden')).toBe(true);
  });
});
