import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { mswServer } from './fixtures/setup.js';

const TEST_EMAIL = 'user@example.com';
const CONTACT_RESOURCE = 'people/c1234567890';

const CONTACTS_WRITE_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts',
].join(' ');

let cleanupDir: string | undefined;

function createWorkspaceEnv(scopes: string = CONTACTS_WRITE_SCOPES): void {
  cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-contacts-write-'));
  const credentialsPath = path.join(cleanupDir, 'credentials');
  fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(cleanupDir, 'accounts.json'),
    JSON.stringify({
      accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Mock API user' }],
    }),
  );
  fs.writeFileSync(
    path.join(credentialsPath, 'user-example-com.token.json'),
    JSON.stringify({
      access_token: 'mock-access-token',
      refresh_token: 'mock-refresh-token',
      expiry_date: Date.now() + 60 * 60 * 1000,
      scope: scopes,
    }),
    { mode: 0o600 },
  );

  vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir, 'accounts.json'));
  vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
  vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
  vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
}

async function loadHandlers() {
  createWorkspaceEnv();
  vi.resetModules();
  const { initializeAllServices } = await import('../src/utils/service-initializer.js');
  await initializeAllServices();
  return import('../src/tools/contacts-handlers.js');
}

function installPeopleApiMocks(): void {
  mswServer.use(
    http.post('https://people.googleapis.com/v1/people:createContact', async ({ request }) => {
      const body = await request.json() as {
        names?: Array<{ givenName?: string; familyName?: string }>;
        emailAddresses?: Array<{ value?: string }>;
        organizations?: Array<{ name?: string }>;
      };
      return HttpResponse.json({
        resourceName: CONTACT_RESOURCE,
        etag: 'etag-new',
        names: [{
          displayName: `${body.names?.[0]?.givenName ?? ''} ${body.names?.[0]?.familyName ?? ''}`.trim(),
          givenName: body.names?.[0]?.givenName,
          familyName: body.names?.[0]?.familyName,
        }],
        emailAddresses: body.emailAddresses,
        organizations: body.organizations,
      });
    }),
    http.get(new RegExp(`https://people\\.googleapis\\.com/v1/${CONTACT_RESOURCE}`), () => HttpResponse.json({
      resourceName: CONTACT_RESOURCE,
      etag: 'etag-current',
      names: [{ displayName: 'Jane Doe', givenName: 'Jane', familyName: 'Doe' }],
    })),
    http.patch(/https:\/\/people\.googleapis\.com\/v1\/people\/c\d+:updateContact/, async ({ request }) => {
      const url = new URL(request.url);
      const body = await request.json() as {
        etag?: string;
        phoneNumbers?: Array<{ value?: string }>;
        organizations?: Array<{ name?: string }>;
      };
      return HttpResponse.json({
        resourceName: CONTACT_RESOURCE,
        etag: 'etag-updated',
        names: [{ displayName: 'Jane Doe' }],
        phoneNumbers: body.phoneNumbers,
        organizations: body.organizations,
        sentUpdateMask: url.searchParams.get('updatePersonFields'),
        sentEtag: body.etag,
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  if (cleanupDir) {
    fs.rmSync(cleanupDir, { recursive: true, force: true });
    cleanupDir = undefined;
  }
});

describe('contacts write tools', () => {
  it('exposes create/update contact definitions', async () => {
    const { contactsTools } = await import('../src/tools/definitions/contacts.js');
    const names = contactsTools.map(tool => tool.name);
    expect(names).toContain('create_workspace_contact');
    expect(names).toContain('update_workspace_contact');
    const update = contactsTools.find(tool => tool.name === 'update_workspace_contact');
    expect(update?.inputSchema.required).toContain('resource_name');
    expect(update?.annotations?.readOnlyHint).toBe(false);
  });

  it('creates a contact and returns an enveloped summary', async () => {
    installPeopleApiMocks();
    const handlers = await loadHandlers();
    const result = await handlers.handleCreateContact({
      email: TEST_EMAIL,
      given_name: 'Jane',
      family_name: 'Doe',
      email_address: 'jane@example.com',
      organization: 'Acme Corp',
    }) as { status: string; contact: { resourceName: string; organization?: string } };

    expect(result.status).toContain('success');
    // Whole-result wrapping is the connector's established convention (matches
    // get_workspace_contacts), so identifiers arrive enveloped too.
    expect(result.contact.resourceName).toContain(CONTACT_RESOURCE);
    // Attacker-controlled organization text must be enveloped
    expect(result.contact.organization).toContain('<untrusted-content');
    expect(result.contact.organization).toContain('Acme Corp');
  });

  it('updates only the provided fields and forwards the current etag', async () => {
    let seenUpdateMask: string | null = null;
    let seenEtag: string | undefined;
    mswServer.use(
      http.get(new RegExp(`https://people\\.googleapis\\.com/v1/${CONTACT_RESOURCE}`), () => HttpResponse.json({
        resourceName: CONTACT_RESOURCE,
        etag: 'etag-current',
      })),
      http.patch(/https:\/\/people\.googleapis\.com\/v1\/people\/c\d+:updateContact/, async ({ request }) => {
        const url = new URL(request.url);
        seenUpdateMask = url.searchParams.get('updatePersonFields');
        const body = await request.json() as { etag?: string; phoneNumbers?: Array<{ value?: string }> };
        seenEtag = body.etag;
        return HttpResponse.json({
          resourceName: CONTACT_RESOURCE,
          etag: 'etag-updated',
          phoneNumbers: body.phoneNumbers,
        });
      }),
    );
    const handlers = await loadHandlers();
    const result = await handlers.handleUpdateContact({
      email: TEST_EMAIL,
      resource_name: CONTACT_RESOURCE,
      phone_number: '+1 555 0100',
    }) as { status: string; contact: { etag?: string; phone?: string } };

    expect(seenUpdateMask).toBe('phoneNumbers');
    expect(seenEtag).toBe('etag-current');
    expect(result.contact.phone).toContain('+1 555 0100');
  });

  it('rejects a create without any identifying field', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleCreateContact({ email: TEST_EMAIL, notes: 'no name or email' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects an update without resource_name', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateContact({ email: TEST_EMAIL, phone_number: '+1 555 0100' }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('rejects an update with no fields to change', async () => {
    const handlers = await loadHandlers();
    await expect(
      handlers.handleUpdateContact({ email: TEST_EMAIL, resource_name: CONTACT_RESOURCE }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('surfaces the real People API error on failure', async () => {
    mswServer.use(
      http.post('https://people.googleapis.com/v1/people:createContact', () => HttpResponse.json(
        { error: { message: 'Request had insufficient authentication scopes.' } },
        { status: 403 },
      )),
    );
    const handlers = await loadHandlers();
    try {
      await handlers.handleCreateContact({ email: TEST_EMAIL, given_name: 'Jane' });
      expect.unreachable('expected create to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as Error).message).toContain('403');
    }
  });

  it('fails with reconnect guidance when only the read-only scope was granted', async () => {
    installPeopleApiMocks();
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-workspace-contacts-write-'));
    const credentialsPath = path.join(cleanupDir, 'credentials');
    fs.mkdirSync(credentialsPath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(cleanupDir, 'accounts.json'),
      JSON.stringify({ accounts: [{ email: TEST_EMAIL, category: 'work', description: 'Mock API user' }] }),
    );
    fs.writeFileSync(
      path.join(credentialsPath, 'user-example-com.token.json'),
      JSON.stringify({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expiry_date: Date.now() + 60 * 60 * 1000,
        scope: 'https://www.googleapis.com/auth/contacts.readonly',
      }),
      { mode: 0o600 },
    );
    vi.stubEnv('ACCOUNTS_PATH', path.join(cleanupDir, 'accounts.json'));
    vi.stubEnv('CREDENTIALS_PATH', credentialsPath);
    vi.stubEnv('GOOGLE_CLIENT_ID', 'mock-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'mock-client-secret');
    vi.stubEnv('MCP_WORKSPACE_PATH', cleanupDir);
    vi.resetModules();
    const { initializeAllServices } = await import('../src/utils/service-initializer.js');
    await initializeAllServices();
    const handlers = await import('../src/tools/contacts-handlers.js');

    try {
      await handlers.handleCreateContact({ email: TEST_EMAIL, given_name: 'Jane' });
      expect.unreachable('expected create to fail');
    } catch (error) {
      expect((error as Error).message).toContain('Contacts');
    }
  });
});
