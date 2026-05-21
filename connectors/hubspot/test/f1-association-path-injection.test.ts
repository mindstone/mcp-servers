/**
 * F-1 (pre-publish security review for v0.2.0) — Association tool path-segment
 * injection regression test.
 *
 * Background: FOX-3354 removed the enum that previously restricted
 * fromObjectType / toObjectType to ['contacts','companies','deals','tickets',
 * 'leads']. The enum had been doing double duty as a UX guardrail AND an
 * implicit injection prevention (none of those values contain '/' or '?').
 * Removing the enum exposed raw string interpolation in HubSpotClient
 * association methods. 0.2.0 introduces validators + encodeURIComponent at
 * the API-client boundary.
 *
 * This file locks in:
 *   - Negative: malicious type/id values must be rejected with INVALID_ARGUMENTS
 *   - Positive: legitimate custom-object-type IDs (e.g. '2-12345') and snake
 *     case names ('line_items', 'p_widgets') must be accepted
 *
 * The validators live in src/api/hubspot-client.ts so a future refactor of
 * the per-callsite pattern can't silently re-open the regression.
 */

import { describe, expect, it } from 'vitest';
import {
  assertHubSpotObjectType,
  assertHubSpotObjectId,
  assertHubSpotAssociationType,
} from '../src/api/hubspot-client.js';

describe('F-1 — HubSpot association path-segment validators', () => {
  describe('assertHubSpotObjectType', () => {
    it.each([
      'contacts',
      'companies',
      'deals',
      'tickets',
      'leads',
      'line_items',
      'products',
      'p_widgets',
      '2-12345',
      '2-345678',
      'P_CUSTOM',
    ])('accepts legitimate object type %s', value => {
      expect(() => assertHubSpotObjectType(value, 'fromObjectType')).not.toThrow();
    });

    it.each([
      'contacts/999/associations/contacts/777',
      'contacts?archived=false',
      'contacts#fragment',
      'contacts/',
      '/contacts',
      'contacts%2F999',
      'contacts contacts',
      'contacts\n',
      '..',
      '',
      'contacts'.repeat(20),
      'cön', // non-ASCII
    ])('rejects malicious or malformed object type %j', value => {
      expect(() => assertHubSpotObjectType(value, 'fromObjectType')).toThrow(
        /INVALID_ARGUMENTS.*fromObjectType/
      );
    });

    it.each([null, undefined, 123, {}, [], true])(
      'rejects non-string object type %p',
      value => {
        expect(() =>
          assertHubSpotObjectType(value as unknown as string, 'fromObjectType')
        ).toThrow(/INVALID_ARGUMENTS/);
      }
    );
  });

  describe('assertHubSpotObjectId', () => {
    it.each([
      '417731291364',
      '719144850619',
      '1',
      'abc-123_DEF',
      'a'.repeat(64),
    ])('accepts legitimate object ID %s', value => {
      expect(() => assertHubSpotObjectId(value, 'fromObjectId')).not.toThrow();
    });

    it.each([
      '123/456',
      '123?foo=bar',
      '123#bar',
      '../etc/passwd',
      '',
      'a'.repeat(65),
      '12 34',
    ])('rejects malformed object ID %j', value => {
      expect(() => assertHubSpotObjectId(value, 'fromObjectId')).toThrow(
        /INVALID_ARGUMENTS.*fromObjectId/
      );
    });
  });

  describe('assertHubSpotAssociationType', () => {
    it.each([
      'deal_to_contact',
      'ticket_to_contact',
      'ticket_to_company',
      'custom_label_1',
      '101',
      'a'.repeat(128),
    ])('accepts legitimate association type %s', value => {
      expect(() => assertHubSpotAssociationType(value)).not.toThrow();
    });

    it.each([
      'deal_to/contact',
      'deal_to_contact?archived=false',
      '',
      'a'.repeat(129),
    ])('rejects malformed association type %j', value => {
      expect(() => assertHubSpotAssociationType(value)).toThrow(
        /INVALID_ARGUMENTS.*associationType/
      );
    });
  });

  describe('end-to-end via HubSpotClient (mocked request)', () => {
    it('rejects injection attempt before any HTTP call is made', async () => {
      const { HubSpotClient } = await import('../src/api/hubspot-client.js');
      let calls = 0;
      const client = new HubSpotClient('fake-token', {
        onUnauthenticated: () => {},
        onRefresh: async () => 'fake-token',
      });
      // Monkey-patch the private request method to count invocations.
      const original = (client as unknown as { request: unknown }).request;
      (client as unknown as { request: (...args: unknown[]) => Promise<unknown> }).request =
        async (...args: unknown[]) => {
          calls += 1;
          return (original as (...args: unknown[]) => Promise<unknown>).apply(client, args);
        };

      await expect(
        client.getAssociations(
          'contacts/999/associations/contacts/777',
          '1',
          'deals'
        )
      ).rejects.toThrow(/INVALID_ARGUMENTS/);
      expect(calls).toBe(0); // Critical: assertion must throw BEFORE any HTTP call.
    });
  });
});
