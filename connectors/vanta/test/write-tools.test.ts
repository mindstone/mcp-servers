import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import { setDnsLookupForTesting } from '../src/api.js';
import { setRemoteDocumentLimitsForTesting } from '../src/remote-document.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  successTokenHandler,
} from './helpers/vanta-mock-api.js';

const SOURCE_URL = 'https://files.example.com/evidence/access-review.pdf';
const SOURCE_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

/** Point every source hostname at a public IP so the DNS anti-rebind layer passes. */
const allowPublicDns = () => {
  setDnsLookupForTesting(async () => [{ address: '93.184.216.34', family: 4 }]);
};

const sourceFileHandler = (
  url = SOURCE_URL,
  contentType = 'application/pdf',
  bytes = SOURCE_BYTES,
) =>
  http.get(url, () =>
    HttpResponse.arrayBuffer(bytes.buffer.slice(0) as ArrayBuffer, {
      headers: { 'Content-Type': contentType },
    }),
  );

interface CapturedMultipart {
  method: string;
  path: string;
  contentType: string | null;
  fields: Record<string, string>;
  file?: { name: string; type: string; size: number; text: string };
}

const captureMultipart = (
  urlPattern: string,
  responseBody: Record<string, unknown>,
  status = 200,
) => {
  const captured: CapturedMultipart = { method: '', path: '', contentType: null, fields: {} };
  const handler = http.post(urlPattern, async ({ request }) => {
    captured.method = request.method;
    captured.path = new URL(request.url).pathname;
    captured.contentType = request.headers.get('content-type');
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        captured.fields[key] = value;
      } else {
        captured.file = {
          name: value.name,
          type: value.type,
          size: value.size,
          text: await value.text(),
        };
      }
    }
    return HttpResponse.json(responseBody, { status });
  });
  return { captured, handler };
};

describe('Vanta write tools', () => {
  let client: McpTestClient;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
    setDnsLookupForTesting(null);
    setRemoteDocumentLimitsForTesting(null);
  });

  const setupClient = async () => {
    mswServer.use(successTokenHandler);
    const { createServer } = await import('../src/server.js');
    client = await createInMemoryTestClient({
      createServer,
      env: {
        VANTA_CLIENT_ID: MOCK_CLIENT_ID,
        VANTA_CLIENT_SECRET: MOCK_CLIENT_SECRET,
      },
    });
  };

  describe('vanta_create_vendor', () => {
    it('sends POST /v1/vendors with the minimum documented body', async () => {
      await setupClient();

      let capturedMethod = '';
      let capturedPath = '';
      let capturedBody: any = null;

      mswServer.use(
        http.post('https://api.vanta.com/v1/vendors', async ({ request }) => {
          capturedMethod = request.method;
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json({ id: 'vendor_123', name: 'Test Vendor' });
        }),
      );

      const result = await client.callTool('vanta_create_vendor', {
        vendor_name: 'Test Vendor',
      });

      expect(result.isError).toBeFalsy();
      expect(capturedMethod).toBe('POST');
      expect(capturedPath).toBe('/v1/vendors');
      expect(capturedBody).toEqual({
        name: 'Test Vendor',
      });
    });

    it('sends optional create fields when provided', async () => {
      await setupClient();

      let capturedMethod = '';
      let capturedPath = '';
      let capturedBody: any = null;

      mswServer.use(
        http.post('https://api.vanta.com/v1/vendors', async ({ request }) => {
          capturedMethod = request.method;
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json({ id: 'vendor_123', name: 'Test Vendor' });
        }),
      );

      const result = await client.callTool('vanta_create_vendor', {
        vendor_name: 'Test Vendor',
        vendor_website: 'https://example.com',
        vendor_category: 'cloudMonitoring',
        description: 'A test vendor',
        vendor_contact_name: 'Alice',
        vendor_contact_email: 'alice@example.com',
        risk_level: 'HIGH',
      });

      expect(result.isError).toBeFalsy();
      expect(capturedMethod).toBe('POST');
      expect(capturedPath).toBe('/v1/vendors');
      expect(capturedBody).toEqual({
        name: 'Test Vendor',
        websiteUrl: 'https://example.com',
        category: 'cloudMonitoring',
        additionalNotes: 'A test vendor',
        accountManagerName: 'Alice',
        accountManagerEmail: 'alice@example.com',
        inherentRiskLevel: 'HIGH',
      });
    });
  });

  describe('vanta_update_vendor', () => {
    it('sends PATCH /v1/vendors/{vendorId} with documented fields', async () => {
      await setupClient();

      let capturedMethod = '';
      let capturedPath = '';
      let capturedBody: any = null;

      mswServer.use(
        http.patch('https://api.vanta.com/v1/vendors/:vendorId', async ({ request }) => {
          capturedMethod = request.method;
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json({ id: 'vendor_123', name: 'Updated Vendor' });
        }),
      );

      const result = await client.callTool('vanta_update_vendor', {
        vendor_id: 'vendor_123',
        vendor_name: 'Updated Vendor',
        vendor_website: 'https://updated.com',
        vendor_category: 'cloudMonitoring',
        description: 'Updated description',
        vendor_contact_name: 'Bob',
        vendor_contact_email: 'bob@example.com',
        risk_level: 'HIGH',
      });

      expect(result.isError).toBeFalsy();
      expect(capturedMethod).toBe('PATCH');
      expect(capturedPath).toBe('/v1/vendors/vendor_123');
      expect(capturedBody).toEqual({
        name: 'Updated Vendor',
        websiteUrl: 'https://updated.com',
        category: 'cloudMonitoring',
        additionalNotes: 'Updated description',
        accountManagerName: 'Bob',
        accountManagerEmail: 'bob@example.com',
        inherentRiskLevel: 'HIGH',
      });
    });
  });

  describe('vanta_deactivate_vulnerability_monitoring', () => {
    it('sends POST /v1/vulnerabilities/deactivate with documented fields', async () => {
      await setupClient();

      let capturedMethod = '';
      let capturedPath = '';
      let capturedBody: any = null;

      mswServer.use(
        http.post('https://api.vanta.com/v1/vulnerabilities/deactivate', async ({ request }) => {
          capturedMethod = request.method;
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json({ results: [{ id: 'vuln_123', status: 'SUCCESS' }] });
        }),
      );

      const result = await client.callTool('vanta_deactivate_vulnerability_monitoring', {
        vulnerability_id: 'vuln_123',
        deactivate_reason: 'False positive',
        should_reactivate_when_fixable: true,
      });

      expect(result.isError).toBeFalsy();
      expect(capturedMethod).toBe('POST');
      expect(capturedPath).toBe('/v1/vulnerabilities/deactivate');
      expect(capturedBody).toEqual({
        updates: [
          {
            id: 'vuln_123',
            deactivateReason: 'False positive',
            shouldReactivateWhenFixable: true,
          },
        ],
      });
    });
  });

  describe('vanta_reactivate_vulnerability_monitoring', () => {
    it('sends POST /v1/vulnerabilities/reactivate with documented fields', async () => {
      await setupClient();

      let capturedMethod = '';
      let capturedPath = '';
      let capturedBody: any = null;

      mswServer.use(
        http.post('https://api.vanta.com/v1/vulnerabilities/reactivate', async ({ request }) => {
          capturedMethod = request.method;
          capturedPath = new URL(request.url).pathname;
          capturedBody = await request.json();
          return HttpResponse.json({ results: [{ id: 'vuln_123', status: 'SUCCESS' }] });
        }),
      );

      const result = await client.callTool('vanta_reactivate_vulnerability_monitoring', {
        vulnerability_id: 'vuln_123',
      });

      expect(result.isError).toBeFalsy();
      expect(capturedMethod).toBe('POST');
      expect(capturedPath).toBe('/v1/vulnerabilities/reactivate');
      expect(capturedBody).toEqual({
        updates: [
          {
            id: 'vuln_123',
          },
        ],
      });
    });
  });

  describe('vanta_upload_document', () => {
    it('proxies the source file as multipart to POST /v1/documents/{documentId}/uploads', async () => {
      allowPublicDns();
      const { captured, handler } = captureMultipart(
        'https://api.vanta.com/v1/documents/:documentId/uploads',
        { id: 'upload_1', fileName: 'access-review.pdf', title: 'Manual Evidence' },
        201,
      );
      mswServer.use(sourceFileHandler(), handler);
      await setupClient();

      const result = await client.callTool('vanta_upload_document', {
        document_id: 'access-requests',
        document_url: SOURCE_URL,
        description: 'Q3 access review evidence',
        effective_at_date: '2026-07-01',
      });

      const payload = result.json as { ok: boolean; submission_required: boolean };
      expect(payload.ok).toBe(true);
      expect(captured.method).toBe('POST');
      expect(captured.path).toBe('/v1/documents/access-requests/uploads');
      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(captured.file).toBeDefined();
      expect(captured.file?.name).toBe('access-review.pdf');
      expect(captured.file?.type).toBe('application/pdf');
      expect(captured.file?.text).toBe('%PDF');
      expect(captured.fields).toEqual({
        description: 'Q3 access review evidence',
        effectiveAtDate: '2026-07-01',
      });
      // Vanta stores API uploads as drafts until the document is submitted for
      // review, so the tool must say so rather than implying the evidence is live.
      expect(payload.submission_required).toBe(true);
    });

    it('omits optional form fields that were not supplied', async () => {
      allowPublicDns();
      const { captured, handler } = captureMultipart(
        'https://api.vanta.com/v1/documents/:documentId/uploads',
        { id: 'upload_1' },
        201,
      );
      mswServer.use(sourceFileHandler(), handler);
      await setupClient();

      const result = await client.callTool('vanta_upload_document', {
        document_id: 'access-requests',
        document_url: SOURCE_URL,
      });

      expect((result.json as { ok: boolean }).ok).toBe(true);
      expect(captured.fields).toEqual({});
      expect(captured.file?.name).toBe('access-review.pdf');
    });
  });

  describe('vanta_attach_vendor_document', () => {
    it('proxies the source file as multipart to POST /v1/vendors/{vendorId}/documents', async () => {
      allowPublicDns();
      const { captured, handler } = captureMultipart(
        'https://api.vanta.com/v1/vendors/:vendorId/documents',
        { id: 'doc_1', title: 'Acme SOC 2', type: 'SOC2_REPORT' },
      );
      mswServer.use(sourceFileHandler(), handler);
      await setupClient();

      const result = await client.callTool('vanta_attach_vendor_document', {
        vendor_id: 'vendor_123',
        document_url: SOURCE_URL,
        document_type: 'SOC2_REPORT',
        document_name: 'Acme SOC 2 Type II',
        description: 'Provided by the vendor',
      });

      expect((result.json as { ok: boolean }).ok).toBe(true);
      expect(captured.method).toBe('POST');
      expect(captured.path).toBe('/v1/vendors/vendor_123/documents');
      expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(captured.file?.name).toBe('access-review.pdf');
      expect(captured.file?.type).toBe('application/pdf');
      expect(captured.file?.text).toBe('%PDF');
      expect(captured.fields).toEqual({
        type: 'SOC2_REPORT',
        title: 'Acme SOC 2 Type II',
        description: 'Provided by the vendor',
      });
    });

    it('requires document_type because Vanta requires the type form field', async () => {
      allowPublicDns();
      await setupClient();

      const result = await client.callTool('vanta_attach_vendor_document', {
        vendor_id: 'vendor_123',
        document_url: SOURCE_URL,
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('document-source fetch hardening', () => {
    const uploadArgs = (overrides: Record<string, unknown> = {}) => ({
      document_id: 'access-requests',
      document_url: SOURCE_URL,
      ...overrides,
    });

    const callUpload = async (overrides: Record<string, unknown> = {}) => {
      await setupClient();
      const result = await client.callTool('vanta_upload_document', uploadArgs(overrides));
      return result.json as {
        ok: boolean;
        code: string;
        error: string;
        action_required: string;
        next_step: string;
      };
    };

    it('refuses a source URL that points at a private address (SSRF)', async () => {
      const payload = await callUpload({ document_url: 'https://10.0.0.5/secret.pdf' });

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.error).toMatch(/non-public address/);
      expect(payload.next_step).toBeTruthy();
    });

    it('refuses a source hostname whose DNS records resolve to a private address', async () => {
      setDnsLookupForTesting(async () => [{ address: '169.254.169.254', family: 4 }]);
      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.error).toMatch(/resolves to a non-public address/);
    });

    it('refuses a plain http:// source URL', async () => {
      allowPublicDns();
      const payload = await callUpload({ document_url: 'http://files.example.com/doc.pdf' });

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.error).toMatch(/must use the https: protocol/);
    });

    it('aborts a source response that exceeds the size cap while streaming (no Content-Length)', async () => {
      allowPublicDns();
      setRemoteDocumentLimitsForTesting({ maxBytes: 64 });
      mswServer.use(
        http.get(SOURCE_URL, () => {
          const stream = new ReadableStream({
            start(controller) {
              // Five 32-byte chunks with no Content-Length: the cap must be
              // enforced from the bytes actually received, not a declared size.
              for (let i = 0; i < 5; i++) {
                controller.enqueue(new Uint8Array(32));
              }
              controller.close();
            },
          });
          return new HttpResponse(stream, { headers: { 'Content-Type': 'application/pdf' } });
        }),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_TOO_LARGE');
      expect(payload.error).toMatch(/64 bytes/);
    });

    it('rejects a source that declares an oversized Content-Length before streaming', async () => {
      allowPublicDns();
      setRemoteDocumentLimitsForTesting({ maxBytes: 64 });
      mswServer.use(
        http.get(SOURCE_URL, () =>
          new HttpResponse(new Uint8Array(8), {
            headers: { 'Content-Type': 'application/pdf', 'Content-Length': '999999' },
          }),
        ),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_TOO_LARGE');
    });

    it('re-validates every redirect hop and refuses a redirect to a private address', async () => {
      allowPublicDns();
      mswServer.use(
        http.get(SOURCE_URL, () =>
          new HttpResponse(null, { status: 302, headers: { Location: 'https://169.254.169.254/creds' } }),
        ),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.error).toMatch(/redirect/i);
      expect(payload.error).toMatch(/non-public address/);
    });

    it('re-validates redirect hostnames via DNS and refuses private answers', async () => {
      setDnsLookupForTesting(async (hostname) => {
        if (hostname === 'redirected.example.com') {
          return [{ address: '127.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      });
      mswServer.use(
        http.get(SOURCE_URL, () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://redirected.example.com/secret.pdf' },
          })),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('CONFIG_INVALID');
      expect(payload.error).toMatch(/redirect/i);
      expect(payload.error).toMatch(/resolves to a non-public address/);
    });

    it('refuses a redirect chain longer than the hop budget', async () => {
      allowPublicDns();
      mswServer.use(
        http.get('https://files.example.com/hop/:n', ({ params }) => {
          const next = Number(params.n) + 1;
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: `https://files.example.com/hop/${next}` },
          });
        }),
      );

      const payload = await callUpload({ document_url: 'https://files.example.com/hop/1' });

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_REDIRECT_LIMIT');
    });

    it('times out a slow source fetch with a distinct error', async () => {
      allowPublicDns();
      setRemoteDocumentLimitsForTesting({ timeoutMs: 40 });
      mswServer.use(
        http.get(SOURCE_URL, async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return HttpResponse.arrayBuffer(new Uint8Array(4).buffer as ArrayBuffer);
        }),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_TIMEOUT');
    });

    it('times out a response body that dribbles slower than the timeout budget', async () => {
      allowPublicDns();
      setRemoteDocumentLimitsForTesting({ timeoutMs: 40 });
      const { handler } = captureMultipart(
        'https://api.vanta.com/v1/documents/:documentId/uploads',
        { id: 'upload_1' },
        201,
      );
      mswServer.use(handler);
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const requestUrl = input instanceof URL
          ? input.toString()
          : typeof input === 'string'
            ? input
            : input.url;
        if (requestUrl === SOURCE_URL) {
          const neverCompletesBody = {
            getReader() {
              return {
                read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
                cancel: () => Promise.resolve(undefined),
                releaseLock: () => undefined,
                closed: Promise.resolve(undefined),
              } as ReadableStreamDefaultReader<Uint8Array>;
            },
          } as unknown as ReadableStream<Uint8Array>;
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'Content-Type': 'application/pdf' }),
            body: neverCompletesBody,
          } as Response;
        }
        return originalFetch(input, init);
      });

      let payload: {
        ok: boolean;
        code: string;
        error: string;
        action_required: string;
        next_step: string;
      };
      try {
        payload = await callUpload();
      } finally {
        fetchSpy.mockRestore();
      }

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_TIMEOUT');
    });

    it('reports an unreachable or erroring source distinctly', async () => {
      allowPublicDns();
      mswServer.use(
        http.get(SOURCE_URL, () => new HttpResponse('nope', { status: 403 })),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.error).toMatch(/403/);
    });

    it('falls back to a safe content type when the source declares a bogus one', async () => {
      allowPublicDns();
      const { captured, handler } = captureMultipart(
        'https://api.vanta.com/v1/documents/:documentId/uploads',
        { id: 'upload_1' },
        201,
      );
      mswServer.use(sourceFileHandler(SOURCE_URL, 'not a mime type at all'), handler);
      await setupClient();

      const result = await client.callTool('vanta_upload_document', uploadArgs());

      expect((result.json as { ok: boolean }).ok).toBe(true);
      expect(captured.file?.type).toBe('application/octet-stream');
    });

    it('prefers the Content-Disposition filename and sanitizes path traversal', async () => {
      allowPublicDns();
      const { captured, handler } = captureMultipart(
        'https://api.vanta.com/v1/documents/:documentId/uploads',
        { id: 'upload_1' },
        201,
      );
      mswServer.use(
        http.get(SOURCE_URL, () =>
          HttpResponse.arrayBuffer(new Uint8Array(SOURCE_BYTES).buffer as ArrayBuffer, {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="../../etc/pass wd.pdf"',
            },
          }),
        ),
        handler,
      );
      await setupClient();

      await client.callTool('vanta_upload_document', uploadArgs());

      expect(captured.file?.name).toBe('.._.._etc_pass_wd.pdf');
    });

    it('refuses an empty source response instead of uploading zero bytes', async () => {
      allowPublicDns();
      mswServer.use(
        http.get(SOURCE_URL, () =>
          HttpResponse.arrayBuffer(new Uint8Array(0).buffer as ArrayBuffer, {
            headers: { 'Content-Type': 'application/pdf' },
          }),
        ),
      );

      const payload = await callUpload();

      expect(payload.ok).toBe(false);
      expect(payload.code).toBe('SOURCE_UNREACHABLE');
      expect(payload.error).toMatch(/empty/i);
    });
  });
});
