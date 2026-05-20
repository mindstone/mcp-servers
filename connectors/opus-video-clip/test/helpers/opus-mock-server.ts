import { http, HttpResponse } from 'msw';
import {
  MOCK_API_KEY,
  mockBrandTemplates,
  mockResumableLocation,
  mockUploadLinkResponse,
  makeProjectResponse,
  makeCensorJobResponse,
  makeCensorJobStatus,
  makeSocialAccounts,
  makeCollection,
  makeCollectionList,
  makeCollectionExport,
  makeSocialCopyResult,
  mockPostId,
  mockScheduleId,
  mockFullClipId,
  mockProjectId,
  mockCollectionId,
  mockJobId,
} from '../fixtures/opus-data.js';

const BASE = 'https://api.opus.pro';

function checkAuth(request: Request, expectedKey = MOCK_API_KEY) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${expectedKey}`) {
    return HttpResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  return null;
}

/**
 * Standard Opus API handlers covering all endpoints needed for unit tests.
 */
export function createOpusHandlers(expectedKey = MOCK_API_KEY) {
  return [
    // brand templates
    http.get(`${BASE}/api/brand-templates`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      const url = new URL(request.url);
      const q = url.searchParams.get('q');
      if (q === 'mine') {
        return HttpResponse.json(mockBrandTemplates);
      }
      // Document footgun: bare GET returns empty body. We reproduce here.
      return new HttpResponse('', { status: 200 });
    }),

    // create-project
    http.post(`${BASE}/api/clip-projects`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      const body = (await request.json()) as { videoUrl?: string };
      return HttpResponse.json({ ...makeProjectResponse(), sourceUri: body.videoUrl }, { status: 201 });
    }),

    // get-project
    http.get(`${BASE}/api/clip-projects/:projectId`, ({ request, params }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeProjectResponse('COMPLETE'));
    }),

    // share-project
    http.post(`${BASE}/api/clip-projects/:projectId/update-visibility`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ ...makeProjectResponse(), visibility: 'PUBLIC' });
    }),

    // get-clips — Opus wraps the result in `{data: [...]}`
    http.get(`${BASE}/api/exportable-clips`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({
        data: [
          {
            id: mockFullClipId,
            projectId: mockProjectId,
            curationId: mockFullClipId.split('.')[1],
            title: 'Demo Clip',
            durationMs: 19478,
            uriForExport: 'https://ext.cdn.opus.pro/.../ehd.mp4',
          },
        ],
      });
    }),

    // upload-links
    http.post(`${BASE}/api/upload-links`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(mockUploadLinkResponse);
    }),

    // GCS resumable start
    http.post('https://storage.googleapis.com/ext.gcs.opus.pro/*', () => {
      return new HttpResponse('', {
        status: 201,
        headers: {
          'x-goog-resumable-upload-id': 'AAkIAwy-YC6V',
          location: mockResumableLocation,
        },
      });
    }),

    // GCS resumable upload PUT — successful one-shot
    http.put('https://storage.googleapis.com/ext.gcs.opus.pro/*', () => {
      return new HttpResponse('', { status: 200 });
    }),

    // censor-jobs
    http.post(`${BASE}/api/censor-jobs`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeCensorJobResponse(), { status: 201 });
    }),

    http.get(`${BASE}/api/censor-jobs/:jobId`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeCensorJobStatus('CONCLUDED'));
    }),

    // collections
    http.post(`${BASE}/api/collections`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeCollection());
    }),

    http.get(`${BASE}/api/collections`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeCollectionList());
    }),

    http.post(`${BASE}/api/collections/:collectionId/export`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeCollectionExport());
    }),

    http.delete(`${BASE}/api/collections/:collectionId`, ({ request, params }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ data: params.collectionId });
    }),

    // collection-contents
    http.post(`${BASE}/api/collection-contents`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      const body = (await request.json()) as { collectionId: string; contentId: string };
      return HttpResponse.json({ data: body });
    }),

    http.post(`${BASE}/api/collection-contents/delete-collection-contents`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      const body = (await request.json()) as { q?: string };
      if (body.q !== 'findByCollectionIdAndContentId') {
        return HttpResponse.json(
          { errorName: 'InvalidParam', errorMessage: 'q must be findByCollectionIdAndContentId' },
          { status: 400 },
        );
      }
      return HttpResponse.json({ data: 'success' });
    }),

    // social posting
    http.get(`${BASE}/api/social-accounts`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeSocialAccounts());
    }),

    http.post(`${BASE}/api/social-copy-jobs`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ data: { jobId: mockJobId } }, { status: 201 });
    }),

    http.get(`${BASE}/api/social-copy-jobs/:jobId`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json(makeSocialCopyResult('COMPLETED'));
    }),

    http.post(`${BASE}/api/post-tasks`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ data: { postId: mockPostId } }, { status: 201 });
    }),

    http.post(`${BASE}/api/publish-schedules`, async ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ data: { scheduleId: mockScheduleId } }, { status: 201 });
    }),

    http.delete(`${BASE}/api/publish-schedules/:scheduleId`, ({ request }) => {
      const err = checkAuth(request, expectedKey);
      if (err) return err;
      return HttpResponse.json({ data: {} });
    }),
  ];
}
