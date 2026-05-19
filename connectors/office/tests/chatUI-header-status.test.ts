import { describe, expect, it } from 'vitest';
import type { ChatErrorCode } from '../src/addin/chatClient.js';
import {
  CONNECTIVITY_ERROR_CODES_INTERNAL,
  computeHeaderStatus,
} from '../src/addin/chatUI.js';

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
