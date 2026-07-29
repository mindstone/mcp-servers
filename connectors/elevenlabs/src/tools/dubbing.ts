import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsBinaryDownload, elevenLabsFetch, elevenLabsJson } from '../client.js';
import { ENDPOINTS } from '../endpoints.js';
import {
  ElevenLabsError,
  LONG_REQUEST_TIMEOUT_MS,
  type DubbingCreateResponse,
  type DubbingStatusResponse,
} from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { readSandboxedFile, sandboxedFileToBlob } from './file-input.js';

const TERMINAL_DUBBING_STATUSES = new Set(['dubbed', 'failed', 'cancelled']);
const TERMINAL_STATUS_PHRASE = 'dubbed, failed, or cancelled';

function dubbingNextStep(status: string): string {
  if (status === 'dubbed') {
    return 'Call download_dubbed_audio with dubbing_id and language_code.';
  }
  if (status === 'failed') {
    return 'Inspect error_detail; fix source media or retry create_dubbing.';
  }
  if (status === 'cancelled') {
    return 'Job was cancelled — do not poll further; submit a new create_dubbing if needed.';
  }
  return 'Poll get_dubbing again in ~10 seconds.';
}

function envelopDubbingStatusField(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  return wrapUntrusted(value, `elevenlabs:get_dubbing:${field}`);
}

export function registerDubbingTools(server: McpServer): void {
  server.registerTool(
    'create_dubbing',
    {
      description: `Submit an async dubbing job (v1 API). You MUST poll get_dubbing until status is ${TERMINAL_STATUS_PHRASE}.

WHEN TO USE:
- Translate/dub existing audio or video into another language
- Localize a short clip the user already has on disk

EXAMPLE: {"file_path": "/path/in/workspace/clip.mp3", "target_lang": "es", "name": "rebel-live-test-dub"}

RELATED TOOLS:
- get_dubbing: poll job status (every ~10s; respect expected_duration_sec from this response)
- download_dubbed_audio: fetch audio once status is dubbed
- delete_dubbing: cleanup test jobs

RETURNS: dubbing_id and expected_duration_sec. The job runs server-side — poll get_dubbing; do not assume instant completion.

COST: Dubbing credits per minute of source media.`,
      inputSchema: z.object({
        target_lang: z.string().min(2).describe('Target language code (e.g. es, fr, de). Required.'),
        file_path: z.string().optional().describe('Local audio/video file inside MCP_WORKSPACE_PATH (multipart field file).'),
        source_url: z.string().url().optional().describe('Alternatively, a URL ElevenLabs fetches server-side (no local sandbox).'),
        name: z.string().optional().describe('Optional job label (echoed by get_dubbing).'),
        source_lang: z.string().optional().describe('Source language code when known (auto-detect when omitted).'),
        num_speakers: z.number().int().min(1).optional().describe('Number of speakers when known.'),
        watermark: z.boolean().optional().describe('Apply watermark when supported. Default: false.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      if (!args.file_path && !args.source_url) {
        throw new ElevenLabsError(
          'Provide either file_path (local sandboxed file) or source_url (ElevenLabs-side fetch).',
          'INVALID_INPUT',
          'Pass file_path for a clip in MCP_WORKSPACE_PATH, or source_url for a remote asset.',
        );
      }
      if (args.file_path && args.source_url) {
        throw new ElevenLabsError(
          'Provide only one of file_path or source_url, not both.',
          'INVALID_INPUT',
          'Choose a local file_path OR a remote source_url.',
        );
      }

      const formData = new FormData();
      formData.append('target_lang', args.target_lang);
      if (args.name) formData.append('name', args.name);
      if (args.source_lang) formData.append('source_lang', args.source_lang);
      if (args.num_speakers != null) formData.append('num_speakers', String(args.num_speakers));
      formData.append('watermark', String(args.watermark ?? false));

      if (args.file_path) {
        const fileInput = readSandboxedFile(args.file_path);
        formData.append('file', sandboxedFileToBlob(fileInput), fileInput.fileName);
      } else if (args.source_url) {
        formData.append('source_url', args.source_url);
      }

      let data: DubbingCreateResponse;
      try {
        data = await elevenLabsJson<DubbingCreateResponse>(
          apiKey,
          ENDPOINTS.DUBBING,
          { method: 'POST', body: formData, timeoutMs: LONG_REQUEST_TIMEOUT_MS },
        );
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'TIMEOUT') {
          throw new ElevenLabsError(
            error.message,
            'TIMEOUT',
            'The submit may have timed out after uploading, but the job might still be processing. Call get_dubbing with the dubbing_id if you have one, or check recent jobs in the ElevenLabs dashboard before resubmitting to avoid duplicate jobs.',
          );
        }
        throw error;
      }

      const expectedSec = data.expected_duration_sec;
      return JSON.stringify({
        ok: true,
        dubbing_id: data.dubbing_id,
        expected_duration_sec: expectedSec,
        target_lang: args.target_lang,
        message: `Dubbing job ${data.dubbing_id} submitted. You MUST poll get_dubbing every ~10 seconds until status is ${TERMINAL_STATUS_PHRASE}${expectedSec != null ? ` (expected ~${expectedSec}s)` : ''}.`,
        poll_hint: `Call get_dubbing with this dubbing_id until status is ${TERMINAL_STATUS_PHRASE}; when dubbed, call download_dubbed_audio.`,
      });
    }),
  );

  server.registerTool(
    'get_dubbing',
    {
      description: `Poll dubbing job status. Call repeatedly after create_dubbing until status is ${TERMINAL_STATUS_PHRASE}.

WHEN TO USE:
- After create_dubbing — poll every ~10s (respect expected_duration_sec)
- Check whether a dub failed before retrying

EXAMPLE: {"dubbing_id": "dub_abc123"}

RELATED TOOLS:
- create_dubbing: submit the job
- download_dubbed_audio: fetch audio when status is dubbed
- delete_dubbing: remove test jobs

RETURNS: status (verbatim, incl. failed), enveloped name and error detail when present.

COST: FREE — status read only.`,
      inputSchema: z.object({
        dubbing_id: z.string().min(1).describe('Dubbing job ID from create_dubbing.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      let data: DubbingStatusResponse;
      try {
        data = await elevenLabsJson<DubbingStatusResponse>(
          apiKey,
          ENDPOINTS.dubbing(args.dubbing_id),
        );
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Dubbing job not found: ${args.dubbing_id}`,
            'DUBBING_NOT_FOUND',
            'Verify the dubbing_id from create_dubbing or list recent jobs in the ElevenLabs dashboard.',
          );
        }
        throw error;
      }

      const status = data.status;
      const errorDetail = data.error_message ?? data.error;
      const isTerminal = TERMINAL_DUBBING_STATUSES.has(status);

      return JSON.stringify({
        ok: true,
        dubbing_id: data.dubbing_id ?? args.dubbing_id,
        status,
        name: envelopDubbingStatusField(data.name, 'name'),
        target_languages: data.target_languages,
        error_detail: envelopDubbingStatusField(errorDetail, 'error_detail'),
        is_terminal: isTerminal,
        message: isTerminal
          ? `Dubbing ${args.dubbing_id} reached terminal status: ${status}.`
          : `Dubbing ${args.dubbing_id} status: ${status}. Keep polling get_dubbing until ${TERMINAL_STATUS_PHRASE}.`,
        next_step: dubbingNextStep(status),
      });
    }),
  );

  server.registerTool(
    'download_dubbed_audio',
    {
      description: `Download dubbed audio for a completed dubbing job.

WHEN TO USE:
- After get_dubbing reports status dubbed
- Fetch the localized track for a target language

EXAMPLE: {"dubbing_id": "dub_abc123", "language_code": "es"}

RELATED TOOLS:
- get_dubbing: confirm status is dubbed before downloading
- delete_dubbing: cleanup after testing

RETURNS: file_path and size_bytes (extension sniffed from Content-Type).

COST: FREE — download only (generation credits charged at submit).`,
      inputSchema: z.object({
        dubbing_id: z.string().min(1).describe('Dubbing job ID.'),
        language_code: z.string().min(2).describe('Target language code used when creating the dub (e.g. es).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      const audio = await elevenLabsBinaryDownload(
        apiKey,
        ENDPOINTS.dubbingAudio(args.dubbing_id, args.language_code),
      );

      return JSON.stringify({
        ok: true,
        file_path: audio.filePath,
        size_bytes: audio.sizeBytes,
        dubbing_id: args.dubbing_id,
        language_code: args.language_code,
        message: `Dubbed audio saved to ${audio.filePath} (${audio.sizeBytes} bytes).`,
      });
    }),
  );

  server.registerTool(
    'delete_dubbing',
    {
      description: `Permanently delete a dubbing job and its outputs.

WHEN TO USE:
- Cleanup rebel-live-test-* dubbing jobs after live tests
- Remove a failed or unwanted dub from the account

EXAMPLE: {"dubbing_id": "dub_abc123"}

RELATED TOOLS:
- create_dubbing / get_dubbing / download_dubbed_audio: the dubbing lifecycle

RETURNS: ok confirmation. Irreversible.

COST: FREE — no generation; permanently removes the dubbing job.`,
      inputSchema: z.object({
        dubbing_id: z.string().min(1).describe('Dubbing job ID to delete.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'The user adds the ElevenLabs API key in Settings → Connectors in the app. Do not ask for it in chat.',
        );
      }

      try {
        await elevenLabsFetch(apiKey, ENDPOINTS.dubbing(args.dubbing_id), {
          method: 'DELETE',
        });
      } catch (error) {
        if (error instanceof ElevenLabsError && error.code === 'HTTP_404') {
          throw new ElevenLabsError(
            `Dubbing job not found: ${args.dubbing_id}`,
            'DUBBING_NOT_FOUND',
            'The job may already be deleted.',
          );
        }
        throw error;
      }

      return JSON.stringify({
        ok: true,
        dubbing_id: args.dubbing_id,
        message: `Dubbing job ${args.dubbing_id} deleted permanently.`,
      });
    }),
  );
}
