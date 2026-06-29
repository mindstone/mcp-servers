import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchObjectsMock = vi.fn();
const getObjectMock = vi.fn();
const listPropertiesMock = vi.fn();

vi.mock('../src/api/hubspot-client.js', () => ({
  getHubSpotClientAsync: vi.fn(async () => ({
    searchObjects: searchObjectsMock,
    getObject: getObjectMock,
    listProperties: listPropertiesMock,
  })),
  // Re-export the error class shape used by crm-handlers' parseHubSpotError.
  HubSpotApiError: class HubSpotApiError extends Error {
    statusCode: number;
    details?: unknown;
    constructor(message: string, statusCode = 500, details?: unknown) {
      super(message);
      this.statusCode = statusCode;
      this.details = details;
    }
  },
}));

import {
  handleSearchTickets,
  handleGetTicket,
} from '../src/tools/crm-handlers.js';
import {
  clearPropertySchemaCache,
  type PropertySuggestion,
} from '../src/tools/property-validation.js';
import { MAX_REQUESTED_PROPERTIES } from '../src/tools/input-limits.js';

// HubSpot tickets carry `time_to_first_agent_reply` — NOT
// `hs_time_to_first_agent_reply`. The latter is the canonical "bad name" bug.
const TICKET_PROPERTIES = [
  { name: 'subject', label: 'Subject', type: 'string', fieldType: 'text' },
  { name: 'content', label: 'Content', type: 'string', fieldType: 'textarea' },
  {
    name: 'time_to_first_agent_reply',
    label: 'Time to first agent reply',
    type: 'number',
    fieldType: 'number',
  },
  {
    name: 'hs_pipeline_stage',
    label: 'Pipeline stage',
    type: 'enumeration',
    fieldType: 'select',
  },
];

function mockTicketSchema() {
  listPropertiesMock.mockResolvedValue({ results: TICKET_PROPERTIES });
}

function findSuggestion(
  suggestions: PropertySuggestion[] | undefined,
  requested: string,
): string | undefined {
  return suggestions?.find((s) => s.requested === requested)?.suggestion;
}

describe('CRM read property-name validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPropertySchemaCache();
    searchObjectsMock.mockResolvedValue({ results: [{ id: '1', properties: {} }] });
    getObjectMock.mockResolvedValue({ id: '1', properties: {} });
  });

  describe('search path', () => {
    it('warns when a requested property is unknown and suggests the close match', async () => {
      mockTicketSchema();

      const result = await handleSearchTickets({
        properties: ['subject', 'hs_time_to_first_agent_reply'],
      });

      // Data is still returned.
      expect(result.results).toEqual([{ id: '1', properties: {} }]);

      const validation = result.propertyValidation;
      expect(validation).toBeDefined();
      // F1: the variable names live ONLY in structured fields, not in prose.
      expect(validation?.unknownProperties).toEqual(['hs_time_to_first_agent_reply']);
      expect(findSuggestion(validation?.suggestions, 'hs_time_to_first_agent_reply')).toBe(
        'time_to_first_agent_reply',
      );
      // Warning prose is connector-authored and generic — no inlined names.
      expect(validation?.warnings[0]).not.toContain('hs_time_to_first_agent_reply');
      expect(validation?.warnings[0]).toContain('unknownProperties');
      expect(validation?.warnings[0]).toContain('suggestions');
    });

    it('does NOT warn when all requested properties are valid', async () => {
      mockTicketSchema();

      const result = await handleSearchTickets({
        properties: ['subject', 'time_to_first_agent_reply'],
      });

      expect(result.results).toBeDefined();
      expect(result.propertyValidation).toBeUndefined();
    });

    it('does NOT warn when no properties are requested', async () => {
      const result = await handleSearchTickets({});

      expect(result.propertyValidation).toBeUndefined();
      expect(listPropertiesMock).not.toHaveBeenCalled();
    });

    it('does NOT warn for a valid property whose returned value is null/unset (F5)', async () => {
      mockTicketSchema();
      // Valid requested property, but HubSpot returns it null (unset value).
      searchObjectsMock.mockResolvedValue({
        results: [{ id: '1', properties: { time_to_first_agent_reply: null } }],
      });

      const result = await handleSearchTickets({
        properties: ['time_to_first_agent_reply'],
      });

      expect(result.results).toBeDefined();
      expect(result.propertyValidation).toBeUndefined();
    });

    it('flags a mis-cased property name and suggests the exact casing (F2)', async () => {
      mockTicketSchema();

      const result = await handleSearchTickets({
        // `Subject` is NOT `subject` — HubSpot internal names are case-sensitive.
        properties: ['Subject'],
      });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual(['Subject']);
      expect(findSuggestion(validation?.suggestions, 'Subject')).toBe('subject');
    });

    it('does NOT suggest for very short unknown names (F3)', async () => {
      mockTicketSchema();

      const result = await handleSearchTickets({
        properties: ['id'],
      });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual(['id']);
      // Too short to confidently suggest anything from a large catalog.
      expect(validation?.suggestions).toBeUndefined();
    });

    it('still returns data with a "validation unavailable" warning when listProperties throws (non-fatal)', async () => {
      listPropertiesMock.mockRejectedValue(new Error('boom'));

      const result = await handleSearchTickets({
        properties: ['hs_time_to_first_agent_reply'],
      });

      // Read succeeded (non-fatal).
      expect(result.results).toEqual([{ id: '1', properties: {} }]);

      const validation = result.propertyValidation;
      expect(validation).toBeDefined();
      expect(validation?.warnings[0].toLowerCase()).toContain('could not validate');
      // No unknownProperties claim when validation couldn't run.
      expect(validation?.unknownProperties).toBeUndefined();
    });
  });

  describe('get path', () => {
    it('warns when a requested property is unknown and suggests the close match', async () => {
      mockTicketSchema();

      const result = await handleGetTicket({
        ticketId: '42',
        properties: ['hs_time_to_first_agent_reply'],
      });

      expect(result.id).toBe('1');

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual(['hs_time_to_first_agent_reply']);
      expect(findSuggestion(validation?.suggestions, 'hs_time_to_first_agent_reply')).toBe(
        'time_to_first_agent_reply',
      );
      expect(validation?.warnings[0]).not.toContain('hs_time_to_first_agent_reply');
    });

    it('does NOT warn when all requested properties are valid', async () => {
      mockTicketSchema();

      const result = await handleGetTicket({
        ticketId: '42',
        properties: ['subject', 'content'],
      });

      expect(result.id).toBe('1');
      expect(result.propertyValidation).toBeUndefined();
    });

    it('still returns data with a "validation unavailable" warning when listProperties throws (non-fatal)', async () => {
      listPropertiesMock.mockRejectedValue(new Error('boom'));

      const result = await handleGetTicket({
        ticketId: '42',
        properties: ['hs_time_to_first_agent_reply'],
      });

      expect(result.id).toBe('1');
      expect(result.propertyValidation?.warnings[0].toLowerCase()).toContain('could not validate');
    });
  });

  describe('schema cache', () => {
    it('caches the property schema across reads (single fetch within TTL)', async () => {
      mockTicketSchema();

      await handleSearchTickets({ properties: ['hs_bad_name'] });
      await handleGetTicket({ ticketId: '7', properties: ['hs_bad_name'] });

      expect(listPropertiesMock).toHaveBeenCalledTimes(1);
    });

    it('de-dupes concurrent first reads into a single listProperties call (F4)', async () => {
      let resolveList: (value: { results: typeof TICKET_PROPERTIES }) => void = () => {};
      const listGate = new Promise<{ results: typeof TICKET_PROPERTIES }>((resolve) => {
        resolveList = resolve;
      });
      listPropertiesMock.mockImplementation(() => listGate);

      // Fire two reads before the schema fetch resolves. Both should observe the
      // same in-flight fetch rather than each calling listProperties.
      const p1 = handleSearchTickets({ properties: ['hs_bad_name'] });
      const p2 = handleGetTicket({ ticketId: '9', properties: ['hs_bad_name'] });

      // Let both reads progress to the (gated) listProperties call.
      await vi.waitFor(() => {
        if (listPropertiesMock.mock.calls.length < 1) {
          throw new Error('listProperties not called yet');
        }
      });

      resolveList({ results: TICKET_PROPERTIES });
      await Promise.all([p1, p2]);

      // The second read shared the in-flight promise — only one network call.
      expect(listPropertiesMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('DoS bounds (F1/F2)', () => {
    it('bounds an over-cap count of requested properties (no pathological work, still warns) (F1a)', async () => {
      mockTicketSchema();
      // Far more than the cap, all unknown.
      const requested = Array.from({ length: MAX_REQUESTED_PROPERTIES * 3 }, (_, i) => `bogus_prop_${i}`);

      const result = await handleSearchTickets({ properties: requested });

      const validation = result.propertyValidation;
      expect(validation).toBeDefined();
      // Returned unknown list is capped well below what we sent.
      expect((validation?.unknownProperties?.length ?? 0)).toBeLessThanOrEqual(MAX_REQUESTED_PROPERTIES);
      // Read still succeeded.
      expect(result.results).toBeDefined();
    });

    it('reports a pathologically long requested name as unknown with NO suggestion and no crash (F1b)', async () => {
      mockTicketSchema();
      // Long but within the per-name length cap (so it survives normalization),
      // yet over the suggestion length bound — must not run editDistance.
      const longName = 'x'.repeat(200);

      const result = await handleSearchTickets({ properties: [longName] });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual([longName]);
      expect(findSuggestion(validation?.suggestions, longName)).toBeUndefined();
    });

    it('drops requested names longer than the per-name length cap before processing (F1b)', async () => {
      mockTicketSchema();
      const tooLong = 'y'.repeat(300); // > MAX_REQUESTED_PROPERTY_NAME_LENGTH (256)

      const result = await handleSearchTickets({ properties: [tooLong] });

      // Dropped entirely — nothing to validate, so no warning.
      expect(result.propertyValidation).toBeUndefined();
    });

    it('truncates returned unknownProperties past the report cap with a truncation note (F1c)', async () => {
      mockTicketSchema();
      // 120 unknowns (under the processing cap of 200, over the report cap of 50).
      const requested = Array.from({ length: 120 }, (_, i) => `bogus_prop_${i}`);

      const result = await handleSearchTickets({ properties: requested });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties?.length).toBe(50);
      expect(validation?.warnings.some((w) => w.includes('truncated'))).toBe(true);
    });

    it('drops a suggestion whose value is not a safe identifier (F2)', async () => {
      // A schema property name containing unsafe characters: a mis-case of the
      // request would otherwise be suggested verbatim — must be dropped.
      listPropertiesMock.mockResolvedValue({
        results: [{ name: 'weird-name!', label: 'Weird', type: 'string', fieldType: 'text' }],
      });

      // Request the mis-cased form so the mis-case shortcut would fire.
      const result = await handleSearchTickets({ properties: ['Weird-Name!'] });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual(['Weird-Name!']);
      // Suggestion rejected by the identifier regex — none emitted.
      expect(findSuggestion(validation?.suggestions, 'Weird-Name!')).toBeUndefined();
    });

    it('still warns + suggests for the real bug input (regression guard)', async () => {
      mockTicketSchema();

      const result = await handleSearchTickets({
        properties: ['hs_time_to_first_agent_reply'],
      });

      const validation = result.propertyValidation;
      expect(validation?.unknownProperties).toEqual(['hs_time_to_first_agent_reply']);
      expect(findSuggestion(validation?.suggestions, 'hs_time_to_first_agent_reply')).toBe(
        'time_to_first_agent_reply',
      );
    });
  });
});
