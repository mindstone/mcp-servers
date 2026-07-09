import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getApiKey } from '../auth.js';
import { elevenLabsJson } from '../client.js';
import { ElevenLabsError, type TranscriptionResponse } from '../types.js';
import { wrapUntrusted } from '../untrusted-content.js';
import { withErrorHandling } from '../utils.js';
import { isRemoteUrl, resolveAudioPath } from './path-safety.js';

export function registerTranscriptionTools(server: McpServer): void {
  server.registerTool(
    'transcribe_audio',
    {
      description:
        'Transcribe speech from an audio file to text using ElevenLabs Speech-to-Text. ' +
        'INPUT: Local audio file path (.mp3, .wav, .m4a, .ogg, .flac, .webm, .mp4). ' +
        'Auto-detects language by default. Specify language_code for better accuracy. ' +
        'COST: Credits based on audio duration.',
      inputSchema: z.object({
        file_path: z.string().min(1).describe('Absolute path to local audio file to transcribe.'),
        language_code: z.string().optional().describe('Language code (e.g., "en", "es", "fr"). Auto-detected if omitted.'),
        model_id: z.enum(['scribe_v1']).optional().describe('STT model. Default: scribe_v1.'),
        tag_audio_events: z.boolean().optional().describe('When true, include non-speech events like "(laughter)" in the transcript. Default: false.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    withErrorHandling(async (args) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new ElevenLabsError(
          'ElevenLabs API key not configured',
          'AUTH_REQUIRED',
          'Ask the user for their API key, then call configure_elevenlabs_api_key.',
        );
      }

      const rawFilePath = args.file_path;

      // ----------------------------------------------------------------
      // SECURITY (M3.9): sandbox local audio reads to under
      // `MCP_WORKSPACE_PATH` (or `os.tmpdir()` when unset). Without this,
      // an LLM-supplied `file_path` could exfiltrate arbitrary host bytes
      // (e.g. ~/.ssh/id_rsa, /etc/passwd) via the multipart upload to
      // ElevenLabs Speech-to-Text.
      //
      // - Remote URL inputs bypass the sandbox: `transcribe_audio`
      //   currently only handles local-file inputs, so a URL string falls
      //   through to the existing FILE_NOT_FOUND branch (a non-sandbox
      //   error code, preserving pre-fix behaviour for URL inputs).
      // - Local paths run through `resolveAudioPath`, which:
      //     1. Lexically resolves `~` and `..` and rejects paths outside
      //        the workspace root before any disk read.
      //     2. Canonicalises the file via `fs.realpathSync` so a symlink
      //        inside the workspace pointing OUTSIDE the workspace is
      //        refused.
      // ----------------------------------------------------------------
      let filePath: string;
      if (isRemoteUrl(rawFilePath)) {
        // Preserve pre-existing behaviour for URL inputs: the
        // existsSync branch below will return a clean FILE_NOT_FOUND
        // (a non-sandbox error code).
        filePath = rawFilePath;
      } else {
        const resolution = resolveAudioPath(rawFilePath);
        if (!resolution.ok) {
          // Surface the sandbox / not-found error via the standard
          // ElevenLabsError path so withErrorHandling renders it with a
          // stable shape and a code.
          const code = resolution.error.startsWith('File not found')
            ? 'FILE_NOT_FOUND'
            : 'PATH_SANDBOX_VIOLATION';
          throw new ElevenLabsError(
            resolution.error,
            code,
            'Provide a path to an existing audio file inside MCP_WORKSPACE_PATH (or os.tmpdir() when unset). Remote URLs are not supported.',
          );
        }
        filePath = resolution.path;
      }

      // Read local file
      if (!fs.existsSync(filePath)) {
        throw new ElevenLabsError(
          `File not found: ${rawFilePath}`,
          'FILE_NOT_FOUND',
          'Provide an absolute path to an existing audio file.',
        );
      }

      // Defence-in-depth: re-canonicalise via realpathSync at the very
      // last moment to close the (vanishingly small) TOCTOU window
      // between sandbox validation and the readFileSync call. URL inputs
      // skip this since they did not go through the sandbox.
      const verifiedPath = isRemoteUrl(rawFilePath) ? filePath : fs.realpathSync(filePath);
      const fileBuffer = fs.readFileSync(verifiedPath);
      const fileName = path.basename(verifiedPath);

      // Multipart upload. ElevenLabs Speech-to-Text v1 requires:
      //   - field name `file` (NOT `audio` — see planning doc 260520)
      //   - `model_id` is mandatory (only `scribe_v1` is currently supported)
      //   - `tag_audio_events=false` to avoid `(mouse click)` style noise
      const formData = new FormData();
      formData.append('file', new Blob([fileBuffer]), fileName);
      formData.append('model_id', args.model_id ?? 'scribe_v1');
      formData.append('tag_audio_events', String(args.tag_audio_events ?? false));
      if (args.language_code) {
        formData.append('language_code', args.language_code);
      }

      const data = await elevenLabsJson<TranscriptionResponse>(
        apiKey,
        '/speech-to-text',
        {
          method: 'POST',
          body: formData,
        },
      );

      // AGENTS.md invariant #6: the transcript is whatever was SPOKEN in the
      // audio — the most attacker-controllable text this connector returns
      // (anyone recorded can dictate a prompt-injection payload). `message`
      // stays numeric-only; never echo transcript substrings into it.
      return JSON.stringify({
        ok: true,
        text: wrapUntrusted(data.text, 'elevenlabs:transcribe_audio:text'),
        word_count: data.words?.length || 0,
        language: args.language_code || 'auto-detected',
        message: `Transcription complete: ${data.text.length} characters, ${data.words?.length || 0} words.`,
      });
    }),
  );
}
