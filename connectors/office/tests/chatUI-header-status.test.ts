// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';
import type { ChatErrorCode } from '../src/addin/chatClient.js';
import type { TaskpaneState } from '../src/addin/taskpane.js';
import { createInMemoryChatStatePersistence } from '../src/shared/intentClient/persistence.js';
import {
  CONNECTIVITY_ERROR_CODES_INTERNAL,
  computeHeaderStatus,
  createChatUI,
} from '../src/addin/chatUI.js';

function mountHeader(commandState: TaskpaneState) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const ui = createChatUI({
    container, commandState, bridgeConfig: { sidecarToken: 'fictional-token' },
    documentContext: { host: 'word', title: 'Fictional plan.docx' },
  }, {
    persistence: createInMemoryChatStatePersistence(null), getInitialSnapshot: () => null,
    createIntentClient: () => ({
      createConversation: async () => ({ conversationId: 'fictional', state: 'new' }),
      sendMessage: async () => ({ conversationId: 'fictional', messageId: 'message', state: 'submitted', queueSize: 0 }),
      getHistory: async () => ({ conversationId: 'fictional', messages: [], turnStatus: 'idle' }),
      focusInRebel: async () => ({ conversationId: 'fictional', focused: true }),
      connectStream: () => ({ close() {} }),
    }),
  });
  return { ui, container, header: container.querySelector<HTMLElement>('.chat-header')! };
}

afterEach(() => { document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

describe('command availability in the mounted header', () => {
  it.each([
    ['connecting', 'reconnecting'], ['authenticating', 'reconnecting'],
    ['disconnected', 'reconnecting'], ['rebel-closed', 'degraded'], ['connected', 'connected'],
  ] as const)('maps %s with healthy chat to %s', (state, expected) => {
    const { ui, header } = mountHeader(state);
    expect(header.dataset.status).toBe(expected);
    ui.dispose();
  });

  it('updates only the header on acceptance, preserving the body, selection, scroll and composer', () => {
    const { ui, container, header } = mountHeader('authenticating');
    const body = container.querySelector<HTMLElement>('.chat-body')!;
    const content = body.firstChild!;
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'Keep this fictional draft';
    textarea.setSelectionRange(5, 9);
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = document.getSelection()!;
    selection.addRange(range);
    const selected = selection.toString();
    expect(selected.length).toBeGreaterThan(0);
    body.scrollTop = 42;
    expect(header.dataset.status).toBe('reconnecting');
    ui.setCommandState('connected');
    expect(header.dataset.status).toBe('connected');
    expect(body.firstChild).toBe(content);
    expect(body.scrollTop).toBe(42);
    expect(selection.toString()).toBe(selected);
    expect(selection.anchorNode).toBe(range.startContainer);
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Keep this fictional draft');
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 9]);
    ui.dispose();
  });
});

/**
 * Guards the invariant that the header dot never says "connected" when
 * the body is (or is about to be) showing a connectivity-error banner.
 *
 * Regression target: users were seeing a green "Connected" pill in the
 * Word add-in while every message failed with "Rebel isn't responding".
 */
describe('chatUI — header status resolver', () => {
  it('forces not-ready above every health signal', () => {
    // even while reconnecting/degraded, pre-pairing must show not-ready
    expect(computeHeaderStatus('not-ready', 'healthy')).toBe('not-ready');
    expect(computeHeaderStatus('not-ready', 'reconnecting')).toBe('not-ready');
    expect(computeHeaderStatus('not-ready', 'degraded')).toBe('not-ready');
  });

  it('surfaces reconnecting before degraded in the priority ladder', () => {
    expect(computeHeaderStatus('chatting', 'reconnecting')).toBe('reconnecting');
    expect(computeHeaderStatus('idle', 'reconnecting')).toBe('reconnecting');
  });

  it('shows degraded when a connectivity error just fired', () => {
    expect(computeHeaderStatus('chatting', 'degraded')).toBe('degraded');
    expect(computeHeaderStatus('idle', 'degraded')).toBe('degraded');
  });

  it('falls back to connected only when the bridge is actually healthy', () => {
    expect(computeHeaderStatus('chatting', 'healthy')).toBe('connected');
    expect(computeHeaderStatus('idle', 'healthy')).toBe('connected');
  });
});

describe('chatUI — connectivity error classifier', () => {
  it('classifies the "Rebel unreachable" shaped codes as connectivity errors', () => {
    const connectivity: ChatErrorCode[] = [
      'APP_NOT_CONNECTED',
      'PORT_UNREACHABLE',
      'NETWORK_ERROR',
      'TIMEOUT',
    ];
    for (const code of connectivity) {
      expect(CONNECTIVITY_ERROR_CODES_INTERNAL.has(code)).toBe(true);
    }
  });

  it('does NOT classify logical or permission failures as connectivity errors', () => {
    // These should leave the header pill alone — they are not "Rebel is
    // offline" problems.
    const nonConnectivity: ChatErrorCode[] = [
      'UNAUTHORIZED',
      'BAD_REQUEST',
      'NOT_IMPLEMENTED',
      'NOT_FOUND',
    ];
    for (const code of nonConnectivity) {
      expect(CONNECTIVITY_ERROR_CODES_INTERNAL.has(code)).toBe(false);
    }
  });
});
