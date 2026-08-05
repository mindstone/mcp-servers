import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsFetch, elevenLabsJson } from '../client.js';
import { ENDPOINTS, ELEVENLABS_API_V1_BASE } from '../endpoints.js';
import {
  parseApiResponse,
  pronunciationDictionaryListResponseSchema,
  pronunciationDictionaryMetadataSchema,
  pronunciationDictionaryWithRulesSchema,
} from '../api-schemas.js';
import {
  ElevenLabsError,
  type PronunciationDictionaryMetadata,
  type PronunciationDictionaryRule,
  type PronunciationDictionaryWithRules,
} from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';

const AUTH_REQUIRED = () =>
  new ElevenLabsError(
    'ElevenLabs API key not configured',
    'AUTH_REQUIRED',
    'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
  );

const aliasRuleSchema = z.object({
  string_to_replace: z.string().min(1).describe('The word or phrase to replace (e.g. a brand name).'),
  type: z.literal('alias'),
  alias: z.string().min(1).describe('Plain-text respelling used instead (e.g. "tie-land" for "Thailand").'),
  case_sensitive: z.boolean().optional().describe('Match case-sensitively. Default: true.'),
  word_boundaries: z.boolean().optional().describe('Only match at word boundaries. Default: true.'),
});

const phonemeRuleSchema = z.object({
  string_to_replace: z.string().min(1).describe('The word or phrase to replace.'),
  type: z.literal('phoneme'),
  phoneme: z.string().min(1).describe('Phonemic transcription (e.g. "/təˈmeɪtoʊ/").'),
  alphabet: z.enum(['ipa', 'arpabet']).describe('Alphabet of the phoneme string ("ipa" or "arpabet").'),
  case_sensitive: z.boolean().optional().describe('Match case-sensitively. Default: true.'),
  word_boundaries: z.boolean().optional().describe('Only match at word boundaries. Default: true.'),
});

const ruleSchema = z.discriminatedUnion('type', [aliasRuleSchema, phonemeRuleSchema]);

/** Envelope the API-authored free-text fields of a dictionary metadata record. */
function shapeDictionaryMetadata(
  d: PronunciationDictionaryMetadata,
  sourcePrefix: string,
): Record<string, unknown> {
  return {
    id: d.id,
    name: wrapUntrusted(d.name, `${sourcePrefix}:name`),
    description: wrapUntrusted(d.description ?? undefined, `${sourcePrefix}:description`),
    latest_version_id: d.latest_version_id,
    latest_version_rules_num: d.latest_version_rules_num,
    // API-authored string not validated against a closed grammar — envelope it
    // like name/description (AGENTS.md invariant #6).
    permission_on_resource: wrapUntrusted(
      d.permission_on_resource ?? undefined,
      `${sourcePrefix}:permission_on_resource`,
    ),
    creation_time_unix: d.creation_time_unix,
    archived: d.archived_time_unix != null,
    archived_time_unix: d.archived_time_unix ?? undefined,
  };
}

function shapeRule(rule: PronunciationDictionaryRule, sourcePrefix: string): Record<string, unknown> {
  return {
    type: rule.type,
    string_to_replace: wrapUntrusted(rule.string_to_replace, `${sourcePrefix}:rule_string`),
    alias: wrapUntrusted(rule.alias, `${sourcePrefix}:rule_alias`),
    phoneme: wrapUntrusted(rule.phoneme, `${sourcePrefix}:rule_phoneme`),
    alphabet: wrapUntrusted(rule.alphabet, `${sourcePrefix}:rule_alphabet`),
    case_sensitive: rule.case_sensitive,
    word_boundaries: rule.word_boundaries,
  };
}

export function registerPronunciationTools(server: McpServer): void {
  server.registerTool(
    'list_pronunciation_dictionaries',
    {
      description: `List pronunciation dictionaries on this account (brand names, jargon, acronyms the TTS voice should pronounce a specific way).

WHEN TO USE:
- Discover existing pronunciation_dictionary_id values before adding rules or attaching to speech
- Check whether a dictionary for a brand or product already exists

EXAMPLE: {"page_size": 20}

RELATED TOOLS:
- get_pronunciation_dictionary: inspect one dictionary's rules
- add_pronunciation_dictionary: create a new one
- generate_speech_with_timestamps / generate_speech: generation tools dictionaries improve

RETURNS: dictionaries[] with id, enveloped name/description, version info, archived flag; plus next_cursor for pagination.

COST: FREE — read only.`,
      inputSchema: z.object({
        page_size: z.number().int().min(1).max(100).optional().describe('Dictionaries per page (1-100). Default: 30.'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response (next_cursor).'),
        include_archived: z.boolean().optional().describe('Include archived dictionaries. Default: true.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) throw AUTH_REQUIRED();

      const params = new URLSearchParams({ page_size: String(args.page_size ?? 30) });
      if (args.cursor) params.set('cursor', args.cursor);
      if (args.include_archived != null) params.set('include_archived', String(args.include_archived));

      const data = parseApiResponse(
        pronunciationDictionaryListResponseSchema,
        await elevenLabsJson<unknown>(
          apiKey,
          `${ELEVENLABS_API_V1_BASE}${ENDPOINTS.PRONUNCIATION_DICTIONARIES}?${params.toString()}`,
        ),
        'pronunciation dictionary list',
      );

      const dictionaries = (data.pronunciation_dictionaries ?? []).map((d) =>
        shapeDictionaryMetadata(d, 'elevenlabs:list_pronunciation_dictionaries'),
      );

      return JSON.stringify({
        ok: true,
        dictionaries,
        count: dictionaries.length,
        has_more: data.has_more ?? false,
        next_cursor: data.next_cursor ?? undefined,
        cost: 'FREE — read only',
        message:
          `Found ${dictionaries.length} pronunciation dictionar${dictionaries.length === 1 ? 'y' : 'ies'}` +
          (data.has_more ? '; pass next_cursor as cursor for the next page.' : '.'),
      });
    }),
  );

  server.registerTool(
    'get_pronunciation_dictionary',
    {
      description: `Get one pronunciation dictionary's metadata and current rules.

WHEN TO USE:
- Inspect the rules of a dictionary before adding more or attaching it to a generation
- Confirm a brand name is covered

EXAMPLE: {"pronunciation_dictionary_id": "5xM3yVvZQKV0EfqQpLrJ"}

RELATED TOOLS:
- list_pronunciation_dictionaries: find dictionary IDs
- add_pronunciation_dictionary: create a new dictionary

RETURNS: id, enveloped name/description, version info, and rules[] (enveloped rule strings).

COST: FREE — read only.`,
      inputSchema: z.object({
        pronunciation_dictionary_id: z.string().min(1).describe('Dictionary ID from list_pronunciation_dictionaries.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) throw AUTH_REQUIRED();

      let data: PronunciationDictionaryWithRules;
      try {
        data = parseApiResponse(
          pronunciationDictionaryWithRulesSchema,
          await elevenLabsJson<unknown>(
            apiKey,
            ENDPOINTS.pronunciationDictionary(args.pronunciation_dictionary_id),
          ),
          'pronunciation dictionary',
        );
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Pronunciation dictionary not found: ${args.pronunciation_dictionary_id}`,
            'DICTIONARY_NOT_FOUND',
            'Verify the ID with list_pronunciation_dictionaries.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        ...shapeDictionaryMetadata(data, 'elevenlabs:get_pronunciation_dictionary'),
        rules: (data.rules ?? []).map((r) => shapeRule(r, 'elevenlabs:get_pronunciation_dictionary')),
        cost: 'FREE — read only',
        message: `Dictionary has ${data.rules?.length ?? 0} rule${(data.rules?.length ?? 0) === 1 ? '' : 's'} in its latest version.`,
      });
    }),
  );

  server.registerTool(
    'add_pronunciation_dictionary',
    {
      description: `Create a pronunciation dictionary from rules so TTS pronounces brand names, jargon, and acronyms correctly.

WHEN TO USE:
- A voiceover keeps mispronouncing a product or company name
- Set up alias rules ("Thailand" → "tie-land") or IPA phoneme rules before a batch generation

EXAMPLE: {"name": "Brand terms", "rules": [{"string_to_replace": "Thailand", "type": "alias", "alias": "tie-land"}]}

RELATED TOOLS:
- list_pronunciation_dictionaries / get_pronunciation_dictionary: manage existing dictionaries
- archive_pronunciation_dictionary: retire a dictionary
- generate_speech_with_timestamps: apply dictionaries via pronunciation_dictionary_locators

RETURNS: id, version_id, version_rules_num of the new dictionary. Rules are immutable per version — add more by creating a new dictionary.

COST: FREE — metadata write only (no credits).`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Dictionary name (identification only).'),
        description: z.string().optional().describe('Optional description (identification only).'),
        rules: z.array(ruleSchema).min(1).describe('Pronunciation rules: alias rules (plain-text respelling) or phoneme rules (IPA).'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) throw AUTH_REQUIRED();

      const data = parseApiResponse(
        pronunciationDictionaryMetadataSchema,
        await elevenLabsJson<unknown>(
          apiKey,
          ENDPOINTS.PRONUNCIATION_DICTIONARIES_ADD_FROM_RULES,
          {
            method: 'POST',
            body: JSON.stringify({
              name: args.name,
              ...(args.description ? { description: args.description } : {}),
              rules: args.rules,
            }),
          },
        ),
        'pronunciation dictionary creation',
      );

      return JSON.stringify({
        ok: true,
        id: data.id,
        version_id: data.version_id,
        version_rules_num: data.version_rules_num,
        name: wrapUntrusted(data.name, 'elevenlabs:add_pronunciation_dictionary:name'),
        cost: 'FREE — metadata write only',
        message: `Pronunciation dictionary created with ${data.version_rules_num ?? args.rules.length} rule(s). Attach it to generation calls via pronunciation_dictionary_locators (id + version_id).`,
      });
    }),
  );

  server.registerTool(
    'archive_pronunciation_dictionary',
    {
      description: `Archive a pronunciation dictionary so it is no longer applied to generations.

WHEN TO USE:
- Retire an outdated or mistaken dictionary
- Clean up test dictionaries

EXAMPLE: {"pronunciation_dictionary_id": "5xM3yVvZQKV0EfqQpLrJ"}

RELATED TOOLS:
- list_pronunciation_dictionaries: find dictionary IDs (include_archived shows archived ones)
- add_pronunciation_dictionary: create a replacement

RETURNS: ok confirmation. Archiving hides the dictionary from use; it is reversible in the ElevenLabs dashboard.

COST: FREE — metadata write only.`,
      inputSchema: z.object({
        pronunciation_dictionary_id: z.string().min(1).describe('Dictionary ID to archive.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) throw AUTH_REQUIRED();

      try {
        await elevenLabsFetch(apiKey, ENDPOINTS.pronunciationDictionary(args.pronunciation_dictionary_id), {
          method: 'PATCH',
          body: JSON.stringify({ archived: true }),
        });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Pronunciation dictionary not found: ${args.pronunciation_dictionary_id}`,
            'DICTIONARY_NOT_FOUND',
            'The dictionary may already be archived or deleted.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        pronunciation_dictionary_id: args.pronunciation_dictionary_id,
        cost: 'FREE — metadata write only',
        message: `Pronunciation dictionary ${args.pronunciation_dictionary_id} archived. It can be restored in the ElevenLabs dashboard.`,
      });
    }),
  );
}
