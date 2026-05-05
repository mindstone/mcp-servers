import { describe, expect, it } from 'vitest';
import {
  composeHubSpotRequestSignal,
  DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS,
  resolveHubSpotRequestTimeoutMs,
} from '../src/api/hubspot-client.js';

describe('HubSpot request timeout configuration', () => {
  it('uses a 60s default when HUBSPOT_REQUEST_TIMEOUT_MS is unset', () => {
    expect(resolveHubSpotRequestTimeoutMs(undefined)).toBe(DEFAULT_HUBSPOT_REQUEST_TIMEOUT_MS);
  });

  it('applies a valid HUBSPOT_REQUEST_TIMEOUT_MS override', () => {
    expect(resolveHubSpotRequestTimeoutMs('45000')).toBe(45_000);
  });

  it('rejects HUBSPOT_REQUEST_TIMEOUT_MS values above 5 minutes with explicit error', () => {
    expect(() => resolveHubSpotRequestTimeoutMs('300001')).toThrow(
      'Must be less than or equal to 300000 (5 minutes).'
    );
  });

  it('composes caller AbortSignal with built-in timeout using AbortSignal.any()', () => {
    const controller = new AbortController();
    const signal = composeHubSpotRequestSignal(controller.signal, '60000');

    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});
