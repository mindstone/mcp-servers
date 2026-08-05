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

  it('returns an explicit warning when the lookup fails (fail-open but observable)', async () => {
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

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toContain('prompt check could not run');
    expect(result![0]).toContain('network down');
  });

  it('warns instead of returning null when the effective LLM cannot be identified', async () => {
    // The agent lookup succeeded but carries no response_engine.llm_id (e.g. a
    // conversation-flow engine). Validation could not inspect any prompt, so
    // an explicit warning is REQUIRED — a silent null would hide the gap.
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\//,
          response: jsonResponse({
            agent_id: 'agent_cf',
            response_engine: { type: 'conversation-flow', conversation_flow_id: 'cf_1' },
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane' },
      overrideAgentId: 'agent_cf',
    });

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toContain('could not identify the effective prompt');
    expect(result![0]).toContain('agent_cf');
    expect(result![0]).toContain('WITHOUT validation');
  });

  it('fetches the agent at the override version when one is supplied', async () => {
    // The versioned agent's prompt references the passed variable; the
    // unversioned (latest) agent's prompt does not. A null result proves the
    // check validated the versioned prompt — the one that will actually run.
    // (The unversioned get-agent URL has no stub, so hitting it would throw
    // and surface a "could not run" warning instead of null.)
    setApiKey('mock');
    vi.stubGlobal(
      'fetch',
      fetchStub([
        {
          match: /\/get-agent\/agent_x\?version=2$/,
          response: jsonResponse({
            agent_id: 'agent_x',
            version: 2,
            response_engine: { llm_id: 'llm_v2', type: 'retell-llm' },
          }),
        },
        {
          match: /\/get-retell-llm\/llm_v2/,
          response: jsonResponse({
            llm_id: 'llm_v2',
            general_prompt: PROMPT_WITH_TOKENS,
          }),
        },
      ]),
    );

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { customer_name: 'Jane', account_tier: 'pro' },
      overrideAgentId: 'agent_x',
      overrideAgentVersion: 2,
    });

    expect(result).toBeNull();
  });

  it('uses the agent_version from the phone number binding when no override is given', async () => {
    setApiKey('mock');
    const requestedUrls: string[] = [];
    const stub = fetchStub([
      {
        match: /\/get-phone-number\//,
        response: jsonResponse({
          phone_number: '+14155551234',
          outbound_agents: [{ agent_id: 'agent_bound', agent_version: 3 }],
        }),
      },
      {
        match: /\/get-agent\/agent_bound\?version=3$/,
        response: jsonResponse({
          agent_id: 'agent_bound',
          version: 3,
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
    ]);
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      return stub(input, {} as RequestInit);
    });

    const result = await checkDynamicVariableReferences({
      fromNumber: '+14155551234',
      dynamicVariables: { top_action_items: '...' },
    });

    expect(result).not.toBeNull();
    expect(result![0]).toContain('agent_bound');
    expect(result![0]).toContain('version 3');
    expect(requestedUrls.some((u) => u.includes('/get-agent/agent_bound?version=3'))).toBe(true);
  });

  it('also checks begin_message for token references', async () => {    setApiKey('mock');
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
