import { http, HttpResponse, type HttpHandler } from 'msw';

export interface BridgeMockOptions {
  /** Return an error response from the bridge */
  error?: string;
  /** Custom success response data */
  successData?: Record<string, unknown>;
}

/**
 * Creates MSW handlers for the MCP host bridge (http://127.0.0.1:{port}/*).
 * The bridge is used by authenticate_zendesk_account to configure credentials
 * via the host app.
 */
export function createBridgeHandlers(port: number, options: BridgeMockOptions = {}): HttpHandler[] {
  const base = `http://127.0.0.1:${port}`;

  return [
    http.post(`${base}/*`, async ({ request }) => {
      // Verify bearer token is present
      const authHeader = request.headers.get('Authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return HttpResponse.json(
          { success: false, error: 'Missing or invalid authorization' },
          { status: 401 },
        );
      }

      if (options.error) {
        return HttpResponse.json({ success: false, error: options.error });
      }

      return HttpResponse.json({
        success: true,
        ...options.successData,
      });
    }),
  ];
}
