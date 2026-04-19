import { http, HttpResponse } from 'msw';

const BASE = 'https://api-singapore.klingai.com/v1';

const mockTaskId = 'task-kling-abc123';
const mockI2vTaskId = 'task-i2v-456';

/**
 * Creates MSW handlers that mock the Kling API.
 * Verifies Bearer JWT token on every request.
 */
export function createKlingHandlers() {
  const checkAuth = (request: Request) => {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return HttpResponse.json(
        { code: 1000, message: 'Unauthorized', data: null },
        { status: 401 },
      );
    }
    return null;
  };

  return [
    // POST /videos/text2video — start text-to-video generation
    http.post(`${BASE}/videos/text2video`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        code: 0,
        message: 'success',
        data: { task_id: mockTaskId },
      });
    }),

    // GET /videos/text2video/:taskId — check text2video task status
    http.get(`${BASE}/videos/text2video/:taskId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const taskId = params.taskId as string;
      if (taskId === mockTaskId) {
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: {
            task_id: mockTaskId,
            task_status: 'succeed',
            task_status_msg: 'Generation completed',
            task_result: {
              videos: [
                {
                  url: 'https://cdn.klingai.com/video/abc123.mp4',
                  duration: '5',
                  aspect_ratio: '16:9',
                },
              ],
            },
          },
        });
      }
      return HttpResponse.json(
        { code: 1201, message: 'Task not found', data: null },
        { status: 404 },
      );
    }),

    // POST /videos/image2video — start image-to-video generation
    http.post(`${BASE}/videos/image2video`, async ({ request }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      return HttpResponse.json({
        code: 0,
        message: 'success',
        data: { task_id: mockI2vTaskId },
      });
    }),

    // GET /videos/image2video/:taskId — check image2video task status
    http.get(`${BASE}/videos/image2video/:taskId`, ({ request, params }) => {
      const authError = checkAuth(request);
      if (authError) return authError;
      const taskId = params.taskId as string;
      if (taskId === mockI2vTaskId) {
        return HttpResponse.json({
          code: 0,
          message: 'success',
          data: {
            task_id: mockI2vTaskId,
            task_status: 'succeed',
            task_status_msg: 'Generation completed',
            task_result: {
              videos: [
                {
                  url: 'https://cdn.klingai.com/video/i2v-456.mp4',
                  duration: '5',
                },
              ],
            },
          },
        });
      }
      return HttpResponse.json(
        { code: 1201, message: 'Task not found', data: null },
        { status: 404 },
      );
    }),
  ];
}

/**
 * Creates a handler that returns 401 for all Kling API requests.
 */
export function createKlingUnauthorizedHandlers() {
  return [
    http.all(`${BASE}/*`, () =>
      HttpResponse.json(
        { code: 1000, message: 'Unauthorized', data: null },
        { status: 401 },
      ),
    ),
  ];
}

/**
 * Creates a handler that times out for all Kling API requests.
 */
export function createKlingTimeoutHandlers() {
  return [
    http.all(`${BASE}/*`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      return HttpResponse.json({});
    }),
  ];
}

/**
 * Creates a handler that returns 429 (rate limited) for all Kling API requests.
 */
export function createKlingRateLimitHandlers() {
  return [
    http.all(`${BASE}/*`, () =>
      HttpResponse.json(
        { code: 1102, message: 'Insufficient balance', data: null },
        { status: 429 },
      ),
    ),
  ];
}

export { mockTaskId, mockI2vTaskId };
