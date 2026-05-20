import { describe, it, expect, vi, afterEach } from 'vitest';
import { setApiKey } from '../src/client.js';
import { checkDynamicVariableReferences, internal } from '../src/precall-checks.js';

const PROMPT_WITH_TOKENS = 'You are calling {{customer_name}}. Their tier is {{ account_tier }}.';
const PROMPT_GENERIC = 'You are a friendly assistant. Answer any question concisely.';
const PROMPT_PARTIAL = 'Hello {{customer_name}}, we have a quick question.';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fetch stub that returns canned responses per URL pattern. The matcher
 * keeps the test wiring readable and lets each case express only the
 * endpoints it cares about.
 */
function fetchStub(map: Array<{ match: RegExp; response: Response }>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const entry = map.find((m) => m.match.test(url));
    if (!entry) throw new Error(`No fetch stub for ${url}`);
    // Return a fresh clone so each request gets a readable body.
    return entry.response.clone();
  }) as unknown as typeof fetch;
}

describe('extractReferencedTokens', () => {
  it('returns empty set for prompts without tokens', () => {
    expect(internal.extractReferencedTokens(PROMPT_GENERIC)).toEqual(new Set());
  });

  it('extracts {{var}} tokens', () => {
    expect(internal.extractReferencedTokens(PROMPT_WITH_TOKENS)).toEqual(
      new Set(['customer_name', 'account_tier']),
    );
  });

  it('tolerates whitespace inside braces', () => {
    expect(internal.extractReferencedTokens('Hi {{  foo  }} and {{bar}}')).toEqual(
      new Set(['foo', 'bar']),
    );
  });

  it('merges tokens from multiple prompts', () => {
    expect(
      internal.extractReferencedTokens('{{a}} {{b}}', '{{b}} {{c}}', undefined),
    ).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores tokens with invalid identifier shape', () => {
    expect(internal.extractReferencedTokens('{{ 1foo }} {{ a-b }} {{ ok }}')).toEqual(
      new Set(['ok']),
    );
  });
});

describe('checkDynamicVariableReferences', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns null when no dynamic variables are passed', async () => {
    setApiKey('mock');
    vi.stubGlobal('fetch', vi.fn());
    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: {},
      overrideAgentId: 'agent_x',
    });
    expect(result).toBeNull();
  });

  it('returns null when the live prompt references every passed variable', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\//,
          response: jsonResponse({
            agent_id: 'agent_x',
            response_engine: { llm_id: 'llm_y', type: 'retell-llm' },
          }),
        },
        {
          match: /\/get-retell-llm\//,
          response: jsonResponse({
            llm_id: 'llm_y',
            general_prompt: PROMPT_WITH_TOKENS,
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane', account_tier: 'pro' },
      overrideAgentId: 'agent_x',
    });

    expect(result).toBeNull();
  });

  it('warns loudly when none of the passed variables are referenced', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\//,
          response: jsonResponse({
            agent_id: 'agent_x',
            response_engine: { llm_id: 'llm_y', type: 'retell-llm' },
          }),
        },
        {
          match: /\/get-retell-llm\//,
          response: jsonResponse({
            llm_id: 'llm_y',
            general_prompt: PROMPT_GENERIC,
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane', top_action_items: '...' },
      overrideAgentId: 'agent_x',
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toContain('does not reference any of the dynamic variable(s)');
    expect(result![0]).toContain('customer_name');
    expect(result![0]).toContain('top_action_items');
    expect(result![0]).toContain('update_retell_llm');
    expect(result![0]).toContain('publish_agent');
  });

  it('warns partially when some passed variables are referenced but others are not', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\//,
          response: jsonResponse({
            agent_id: 'agent_x',
            response_engine: { llm_id: 'llm_y', type: 'retell-llm' },
          }),
        },
        {
          match: /\/get-retell-llm\//,
          response: jsonResponse({
            llm_id: 'llm_y',
            general_prompt: PROMPT_PARTIAL,
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane', account_tier: 'pro' },
      overrideAgentId: 'agent_x',
    });

    expect(result).not.toBeNull();
    expect(result![0]).toContain('account_tier');
    expect(result![0]).not.toMatch(/does not reference any/);
  });

  it('resolves agent via phone number binding when no override is provided', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-phone-number\//,
          response: jsonResponse({
            phone_number: '+14155551234',
            outbound_agents: [{ agent_id: 'agent_bound', agent_version: 1 }],
          }),
        },
        {
          match: /\/get-agent\/agent_bound/,
          response: jsonResponse({
            agent_id: 'agent_bound',
            response_engine: { llm_id: 'llm_bound' },
          }),
        },
        {
          match: /\/get-retell-llm\//,
          response: jsonResponse({
            llm_id: 'llm_bound',
            general_prompt: PROMPT_GENERIC,
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { top_action_items: '...' },
    });

    expect(result).not.toBeNull();
    expect(result![0]).toContain('agent_bound');
  });

  it('warns when from_number has no outbound agent bound', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-phone-number\//,
          response: jsonResponse({
            phone_number: '+14155551234',
            outbound_agents: [],
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { foo: 'bar' },
    });

    expect(result).not.toBeNull();
    expect(result![0]).toContain('no outbound agent bound');
    expect(result![0]).toContain('update_phone_number');
  });

  it('swallows API errors and returns null (warning is best-effort)', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        throw new Error('network down');
      }),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { foo: 'bar' },
      overrideAgentId: 'agent_x',
    });

    expect(result).toBeNull();
  });

  it('also checks begin_message for token references', async () => {
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\//,
          response: jsonResponse({
            agent_id: 'agent_x',
            response_engine: { llm_id: 'llm_y' },
          }),
        },
        {
          match: /\/get-retell-llm\//,
          response: jsonResponse({
            llm_id: 'llm_y',
            general_prompt: 'You are a helpful assistant.',
            begin_message: 'Hi {{customer_name}}, just calling to check in.',
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane' },
      overrideAgentId: 'agent_x',
    });

    expect(result).toBeNull();
  });
});
