import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_FAN_OUT, MAX_STRING_BODY_LENGTH } from '../src/tools/input-limits.js';

const tempRoots: string[] = [];

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => String(index + 1));
}

async function expectInputTooLarge(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const payload = JSON.parse((error as Error).message) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: 'error',
      errorCode: 'INPUT_TOO_LARGE',
      isError: true,
    });
    return;
  }
  throw new Error('Expected INPUT_TOO_LARGE');
}

async function getInputTooLargePayload(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const payload = JSON.parse((error as Error).message) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: 'error',
      errorCode: 'INPUT_TOO_LARGE',
      isError: true,
    });
    return payload;
  }
  throw new Error('Expected INPUT_TOO_LARGE');
}

function mockHubSpotClient() {
  const client = {
    importFileFromUrlAndWait: vi.fn(async () => ({
      id: 'file-1',
      name: 'file.pdf',
      path: '/attachments/file.pdf',
      url: 'https://files.example.com/file.pdf',
      size: 12,
    })),
    uploadFile: vi.fn(),
    createObject: vi.fn(async () => ({ id: 'note-1' })),
    createObjectWithAssociations: vi.fn(async () => ({ id: 'line-item-1' })),
    createAssociation: vi.fn(async () => undefined),
    enrollInWorkflow: vi.fn(async () => ({ success: true })),
    batchReadContacts: vi.fn(async () => ({ results: [] })),
  };
  const getHubSpotClientAsync = vi.fn(async () => client);

  vi.doMock('../src/api/hubspot-client.js', () => ({
    getHubSpotClientAsync,
    HubSpotApiError: class HubSpotApiError extends Error {
      constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown,
      ) {
        super(message);
      }
    },
  }));

  return { client, getHubSpotClientAsync };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('fan-out input caps', () => {
  it('allows 100 contact IDs for attach_file_to_record', async () => {
    const workspaceRoot = createTempRoot('hubspot-m4-workspace-');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceRoot);
    const { client } = mockHubSpotClient();
    const { handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');

    const result = await handleAttachFileToRecord({
      fileUrl: 'https://example.com/file.pdf',
      associations: { contactIds: ids(MAX_FAN_OUT) },
    });

    expect(result).toMatchObject({ fileId: 'file-1', noteId: 'note-1' });
    expect(client.createAssociation).toHaveBeenCalledTimes(MAX_FAN_OUT);
  });

  it.each([
    ['contactIds'],
    ['companyIds'],
    ['dealIds'],
    ['ticketIds'],
  ] as const)('rejects 101 %s for attach_file_to_record', async (associationKey) => {
    const workspaceRoot = createTempRoot('hubspot-m4-workspace-');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceRoot);
    const { client } = mockHubSpotClient();
    const { handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');

    const payload = await getInputTooLargePayload(handleAttachFileToRecord({
      fileUrl: 'https://example.com/file.pdf',
      associations: { [associationKey]: ids(MAX_FAN_OUT + 1) },
    }));
    expect(payload.message).toContain(`associations.${associationKey}`);
    expect(client.importFileFromUrlAndWait).not.toHaveBeenCalled();
    expect(client.createAssociation).not.toHaveBeenCalled();
  });

  it('rejects 101 workflow object IDs', async () => {
    const { client } = mockHubSpotClient();
    const { handleEnrolInWorkflow } = await import('../src/tools/workflow-handlers.js');

    const payload = await getInputTooLargePayload(handleEnrolInWorkflow({
      flowId: 'flow-1',
      objectIds: ids(MAX_FAN_OUT + 1),
    }));
    expect(payload.message).toContain('objectIds');
    expect(client.enrollInWorkflow).not.toHaveBeenCalled();
  });

  it('rejects 101 CRM note association IDs before creating the note', async () => {
    const { client } = mockHubSpotClient();
    const { handleCreateNote } = await import('../src/tools/crm-handlers.js');

    await expectInputTooLarge(handleCreateNote({
      properties: { hs_note_body: 'hello' },
      associations: { contactIds: ids(MAX_FAN_OUT + 1) },
    }));
    expect(client.createObject).not.toHaveBeenCalled();
  });

  it('rejects oversize string bodies over 1 MiB', async () => {
    const workspaceRoot = createTempRoot('hubspot-m4-workspace-');
    vi.stubEnv('MCP_WORKSPACE_PATH', workspaceRoot);
    const { client } = mockHubSpotClient();
    const { handleAttachFileToRecord } = await import('../src/tools/file-handlers.js');

    const payload = await getInputTooLargePayload(handleAttachFileToRecord({
      fileUrl: 'https://example.com/file.pdf',
      noteBody: 'x'.repeat(MAX_STRING_BODY_LENGTH + 1),
      associations: { contactIds: ['101'] },
    }));
    expect(payload.message).toContain('noteBody');
    expect(client.importFileFromUrlAndWait).not.toHaveBeenCalled();
  });

  it('rejects create_hubspot_line_item oversize properties before resolving the HubSpot client', async () => {
    const { client, getHubSpotClientAsync } = mockHubSpotClient();
    const { handleCreateLineItem } = await import('../src/tools/crm-handlers.js');

    const payload = await getInputTooLargePayload(handleCreateLineItem({
      properties: { name: 'x'.repeat(MAX_STRING_BODY_LENGTH + 1) },
    }));

    expect(payload.message).toContain('properties.name');
    expect(getHubSpotClientAsync).not.toHaveBeenCalled();
    expect(client.createObjectWithAssociations).not.toHaveBeenCalled();
  });

  it('rejects batch_read_hubspot_contacts with more than 100 IDs using structured INPUT_TOO_LARGE', async () => {
    const { client, getHubSpotClientAsync } = mockHubSpotClient();
    const { handleBatchReadContacts } = await import('../src/tools/marketing-handlers.js');

    const payload = await getInputTooLargePayload(handleBatchReadContacts({
      ids: ids(MAX_FAN_OUT + 1),
      properties: ['email'],
    }));

    expect(payload.message).toContain('ids');
    expect(getHubSpotClientAsync).not.toHaveBeenCalled();
    expect(client.batchReadContacts).not.toHaveBeenCalled();
  });
});
