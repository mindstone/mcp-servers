import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTestClient, type McpTestClient } from '@mindstone/mcp-test-harness';
import { http, HttpResponse } from 'msw';

import { mswServer } from './helpers/setup.js';
import {
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  successTokenHandler,
} from './helpers/vanta-mock-api.js';

describe('Vanta write tools', () => {
  let client: McpTestClient;

  afterEach(async () => {
    if (client) {
      await client.close();
    }
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
});
