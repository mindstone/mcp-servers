import { describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { handleComposeWorkspaceEmail } from '../src/tools/gmail-handlers.js';
import * as template from '../src/resources/compose-email-template.js';

vi.mock('../src/modules/gmail/index.js', () => ({ getGmailService: () => ({ initialize: vi.fn() }) }));
vi.mock('../src/modules/accounts/index.js', () => ({
  getAccountManager: () => ({}),
  resolveEmail: async () => 'sender@example.com',
}));
vi.mock('../src/modules/attachments/service.js', () => ({ AttachmentService: { getInstance: () => ({}) } }));

describe('compose declared send', () => {
  it.each([undefined, 'sender@example.com'])('matches the iframe with account choice %s', async email => {
    const result = await handleComposeWorkspaceEmail({
      ...(email === undefined ? {} : { email }), to: [' ada@example.com '], cc: [' cc@example.com '],
      subject: '  Update  ', body: '  indented report\n',
    });
    expect(result._meta.ui.send).toEqual({ tool: 'send_workspace_email', arguments: {
      to: ['ada@example.com'], cc: ['cc@example.com'], bcc: [], subject: '  Update  ', body: '  indented report\n',
      ...(email === undefined ? {} : { email }),
    } });
    expect(result._meta.ui.send).toEqual(template.buildComposeSend(result.structuredContent));
    const window = new Window();
    try {
      window.document.write(template.COMPOSE_EMAIL_HTML);
      window.parent.postMessage = vi.fn();
      window.eval(window.document.querySelector('script')!.textContent!);
      window.dispatchEvent(new window.MessageEvent('message', {
        data: { method: 'ui/notifications/tool-result', params: { structuredContent: result.structuredContent } },
      }));
      expect(window.document.getElementById('fromValue')!.textContent).toBe('sender@example.com');
      window.document.getElementById('sendButton')!.click();
      const call = vi.mocked(window.parent.postMessage).mock.calls.map(call => call[0]).find(message => message.method === 'tools/call');
      expect({ tool: call?.params.name, arguments: call?.params.arguments }).toEqual(result._meta.ui.send);
    } finally { window.close(); }
  });
});
