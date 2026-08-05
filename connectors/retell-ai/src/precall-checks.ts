import { retellFetch } from './client.js';

interface AgentResponse {
  agent_id?: string;
  response_engine?: { llm_id?: string; type?: string };
}

interface LlmResponse {
  llm_id?: string;
  general_prompt?: string;
  begin_message?: string;
}

interface PhoneNumberResponse {
  phone_number?: string;
  outbound_agents?: Array<{ agent_id?: string; agent_version?: number; weight?: number }>;
}

/**
 * Returns the set of {{var_name}} tokens referenced anywhere in the supplied
 * prompt. Whitespace inside the braces is tolerated ({{ foo }} matches "foo").
 */
function extractReferencedTokens(...prompts: Array<string | undefined>): Set<string> {
  const referenced = new Set<string>();
  const tokenPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  for (const prompt of prompts) {
    if (!prompt) continue;
    for (const match of prompt.matchAll(tokenPattern)) {
      referenced.add(match[1]);
    }
  }
  return referenced;
}

/**
 * Inspect the live prompt that will actually run for an outbound call and
 * return warnings the agent should see in the response payload.
 *
 * Fail-open but OBSERVABLE: a lookup error never blocks placing a call (the
 * call tools are annotated destructive and the user asked for the call), but
 * it never disappears silently either — a failed check produces an explicit
 * "could not run" warning string so the degradation is visible in the tool
 * response.
 *
 * Returns null if no warning is warranted; a non-empty array of
 * human-readable warning strings otherwise (including when the check itself
 * could not run).
 */
export async function checkDynamicVariableReferences(input: {
  fromNumber: string;
  dynamicVariables: Record<string, unknown>;
  overrideAgentId?: string;
}): Promise<string[] | null> {
  const dynamicKeys = Object.keys(input.dynamicVariables);
  if (dynamicKeys.length === 0) return null;

  try {
    let agentId = input.overrideAgentId;

    if (!agentId) {
      const phone = await retellFetch<PhoneNumberResponse>(
        `/get-phone-number/${encodeURIComponent(input.fromNumber)}`,
        { method: 'GET' },
      );
      const bound = phone.outbound_agents?.find((entry) => entry && entry.agent_id);
      if (!bound?.agent_id) {
        return [
          `Passed ${dynamicKeys.length} dynamic variable(s) but from_number ${input.fromNumber} has no outbound agent bound. Retell will reject the call. Run update_phone_number to bind an agent, or pass override_agent_id explicitly.`,
        ];
      }
      agentId = bound.agent_id;
    }

    const agent = await retellFetch<AgentResponse>(
      `/get-agent/${encodeURIComponent(agentId)}`,
      { method: 'GET' },
    );
    const llmId = agent.response_engine?.llm_id;
    if (!llmId) return null;

    const llm = await retellFetch<LlmResponse>(
      `/get-retell-llm/${encodeURIComponent(llmId)}`,
      { method: 'GET' },
    );

    const referenced = extractReferencedTokens(llm.general_prompt, llm.begin_message);
    const unreferenced = dynamicKeys.filter((key) => !referenced.has(key));
    if (unreferenced.length === 0) return null;

    if (unreferenced.length === dynamicKeys.length) {
      return [
        `Live prompt on agent ${agentId} (llm_id=${llmId}) does not reference any of the dynamic variable(s) you passed: [${unreferenced.join(', ')}]. Retell only substitutes {{var_name}} tokens that already exist in the prompt — these variables will be silently dropped and the call will run with the previously published prompt. To fix: update_retell_llm on ${llmId} to include {{${unreferenced[0]}}} (and any others), then publish_agent before retrying.`,
      ];
    }

    return [
      `Live prompt on agent ${agentId} (llm_id=${llmId}) does not reference these dynamic variable(s): [${unreferenced.join(', ')}]. They will be silently dropped. Other passed variables [${dynamicKeys.filter((k) => !unreferenced.includes(k)).join(', ')}] are referenced and will substitute. To use all variables, update_retell_llm to add the missing {{var_name}} tokens, then publish_agent.`,
    ];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
      `Dynamic-variable prompt check could not run: ${reason}. The call proceeds WITHOUT validating the passed dynamic variables against the live prompt — unmatched variables are silently dropped. Verify the prompt's {{placeholders}} with get_retell_llm before relying on them.`,
    ];
  }
}

export const internal = { extractReferencedTokens };
