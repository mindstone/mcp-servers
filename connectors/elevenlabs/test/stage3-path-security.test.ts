/**
 * Per-file-param path-sandbox escape matrix for Stage 3 file-input sinks.
 * Covers the same escape classes as transcription-security.test.ts:131-310.
 */
import * as fs from 'fs';
import { describe, it, afterEach, beforeEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';
import {
  captureStage3Endpoint,
  cleanupPathSandboxDirs,
  createPathSandboxDirs,
  expectRemoteUrlFallthrough,
  expectSandboxRejection,
  stage3EscapeCases,
  STAGE3_ENDPOINTS,
  type PathSandboxDirs,
} from './helpers/path-sandbox-matrix.js';

type Stage3Sink = {
  tool: string;
  param: string;
  endpoint: string;
  buildArgs: (filePath: string) => Record<string, unknown>;
};

const SINKS: Stage3Sink[] = [
  {
    tool: 'speech_to_speech',
    param: 'audio_path',
    endpoint: STAGE3_ENDPOINTS.speech_to_speech,
    buildArgs: (filePath) => ({ audio_path: filePath, voice_id: 'voice-rachel-001' }),
  },
  {
    tool: 'isolate_audio',
    param: 'audio_path',
    endpoint: STAGE3_ENDPOINTS.isolate_audio,
    buildArgs: (filePath) => ({ audio_path: filePath }),
  },
  {
    tool: 'forced_alignment',
    param: 'file_path',
    endpoint: STAGE3_ENDPOINTS.forced_alignment,
    buildArgs: (filePath) => ({ file_path: filePath, text: 'Hi.' }),
  },
  {
    tool: 'clone_voice',
    param: 'files[]',
    endpoint: STAGE3_ENDPOINTS.clone_voice,
    buildArgs: (filePath) => ({ name: 'matrix-clone', files: [filePath] }),
  },
];

describe('Stage 3 file-input sinks — per-param path escape matrix', () => {
  let testClient: McpTestClient;
  let dirs: PathSandboxDirs;
  const createdSymlinks: string[] = [];

  beforeEach(() => {
    dirs = createPathSandboxDirs();
  });

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
    for (const link of createdSymlinks) {
      try { fs.unlinkSync(link); } catch { /* ignore */ }
    }
    createdSymlinks.length = 0;
    cleanupPathSandboxDirs(dirs);
  });

  for (const sink of SINKS) {
    describe(`${sink.tool} — ${sink.param}`, () => {
      for (const escapeCase of stage3EscapeCases()) {
        it(`${escapeCase.class} — ${escapeCase.label}`, async () => {
          if (escapeCase.skip?.()) return;

          const { handler, getCalls } = captureStage3Endpoint(sink.endpoint);
          mswServer.use(handler);

          const filePath = escapeCase.buildPath(dirs, createdSymlinks);

          testClient = await createTestClient({
            env: {
              ELEVENLABS_API_KEY: MOCK_API_KEY,
              MCP_HOST_BRIDGE_STATE: '',
              MCP_WORKSPACE_PATH: dirs.workspaceDir,
            },
          });

          const result = await testClient.callTool(sink.tool, sink.buildArgs(filePath));

          if (escapeCase.class === 'remote-url') {
            expectRemoteUrlFallthrough(result, getCalls);
          } else {
            expectSandboxRejection(result, getCalls);
          }
        });
      }
    });
  }
});
