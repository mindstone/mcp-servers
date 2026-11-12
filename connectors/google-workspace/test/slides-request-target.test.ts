import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { mswServer } from './fixtures/setup.js';
import { recordRequests } from './fixtures/record-requests.js';

const TEST_EMAIL = 'user@example.com';
const PRESENTATION_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd';

let cleanupDir: string | undefined;

async function loadSlidesHandlers() {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-slides-'));
  const credentialsPath = path.join(cleanupDir, 'credentials');
  fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cleanupDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Slides test user' }] }),
  );
  fs.writeFileSync(
    path.join(credentialsPath, 'user-example-com.token.json'),
    JSON.stringify({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expiry_date: Date.now() + 60 * 60 * 1000,
      scope: 'https://www.googleapis.com/auth/presentations',
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
  vi.resetModules();
  const { initializeAccountModule } = await import('../src/modules/accounts/index.js');
  await initializeAccountModule();
  return import('../src/tools/slides-handlers.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});


describe('Slides presentation ID request target', () => {
  it.each([
    `${PRESENTATION_ID}?fields=title`,
    `${PRESENTATION_ID}#frag`,
    `${PRESENTATION_ID}&x=1`,
    `${PRESENTATION_ID}/..`,
    `${PRESENTATION_ID}%2F..`,
    '..',
  ])('rejects presentation_id %s before any request is sent', async (presentationId) => {
    const handlers = await loadSlidesHandlers();
    const sent = await recordRequests(async () => {
      await expect(handlers.handleReadPresentation({ email: TEST_EMAIL, presentation_id: presentationId }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(handlers.handleListSlides({ email: TEST_EMAIL, presentation_id: presentationId }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
      await expect(handlers.handleGetSlide({ email: TEST_EMAIL, presentation_id: presentationId, slide_index: 0 }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    });
    expect(sent).toEqual([]);
  });

  it.each([
    PRESENTATION_ID,
    `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit`,
  ])('reads exactly the named presentation (%s)', async (presentationId) => {
    mswServer.use(
      http.get(`https://slides.googleapis.com/v1/presentations/${PRESENTATION_ID}`, () => HttpResponse.json({
        presentationId: PRESENTATION_ID,
        title: 'Quarterly review',
        slides: [],
      })),
    );
    const handlers = await loadSlidesHandlers();
    const sent = await recordRequests(() =>
      handlers.handleReadPresentation({ email: TEST_EMAIL, presentation_id: presentationId }));
    expect(sent).toEqual([`GET https://slides.googleapis.com/v1/presentations/${PRESENTATION_ID}`]);
  });
});
