import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/elevenlabs-data.js';

describe('422 resolution field-path surfacing (F3)', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('includes enveloped flattened field paths in resolution for HTTP 422', async () => {
    mswServer.use(
      http.post('https://api.elevenlabs.io/v1/music', () =>
        HttpResponse.json(
          {
            detail: [
              {
                type: 'missing',
                loc: ['body', 'composition_plan', 'sections', 0, 'section_name'],
                msg: 'Field required',
              },
            ],
          },
          { status: 422 },
        ),
      ),
    );

    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('generate_music_from_plan', {
      composition_plan: {
        sections: [{ section_name: 'X', duration_ms: 5000 }],
      },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.text);
    expect(parsed.code).toBe('HTTP_422');
    expect(parsed.resolution).toContain('Field issues:');
    expect(parsed.resolution).toContain('section_name');
    expect(parsed.resolution).toContain('<untrusted-content source="elevenlabs:api:error_detail">');
  });
});
