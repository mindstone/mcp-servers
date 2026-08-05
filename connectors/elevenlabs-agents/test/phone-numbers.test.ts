import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import {
  createElevenLabsAgentsHandlers,
  createImportPhoneNumberCapturingHandler,
  createUpdatePhoneNumberCapturingHandler,
  MOCK_API_KEY,
} from './helpers/elevenlabs-agents-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { redactCredentialValues } from '../src/redact.js';

/** Format-valid Twilio credentials ("AC" + 32 hex / 32 hex) for the import tests.
 * Built programmatically so no literal trips secret scanners. */
const TWILIO_SID = `AC${'0123456789abcdef'.repeat(2)}`;
const TWILIO_TOKEN = 'fedcba9876543210'.repeat(2);

describe('phone number tools', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  it('lists phone numbers and gets one number by ID', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const listed = await testClient.callTool('list_phone_numbers', { page_size: 1 });
    expect(listed.isError).toBeFalsy();
    expect(listed.json.count).toBe(1);

    const single = await testClient.callTool('get_phone_number', { phone_number_id: 'pn_custom_456' });
    expect(single.isError).toBeFalsy();
    expect(single.json.phone_number.phone_number_id).toBe('pn_custom_456');
  });

  it('updates a phone number label and assigned agent', async () => {
    const { handler, captured } = createUpdatePhoneNumberCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_phone_number', {
      phone_number_id: 'pn_test_123',
      label: 'Sales desk',
      agent_id: 'agent_updated_456',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      label: 'Sales desk',
      agent_id: 'agent_updated_456',
    });
    expect(result.json.phone_number.label).toContain('<untrusted-content');
    expect(result.json.phone_number.assigned_agent_id).toBe('agent_updated_456');
  });

  it('update_phone_number rejects requests without label or agent_id', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('update_phone_number', {
      phone_number_id: 'pn_test_123',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({
      ok: false,
      code: 'INVALID_ARGUMENTS',
    });
    expect(result.json.error).toBe('Provide at least one field to update: label or agent_id.');
  });

  it('imports a Twilio phone number with E.164 validation and sid/token mapping', async () => {
    const { handler, captured } = createImportPhoneNumberCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
      twilio_sid: TWILIO_SID,
      twilio_token: TWILIO_TOKEN,
      agent_id: 'agent_test_123',
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
      agent_id: 'agent_test_123',
      sid: TWILIO_SID,
      token: TWILIO_TOKEN,
    });
    expect(result.json.phone_number.phone_number_id).toBe('pn_imported_123');
  });

  it('imports a SIP trunk number with trunk configs', async () => {
    const { handler, captured } = createImportPhoneNumberCapturingHandler();
    mswServer.use(handler, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'sip_trunk',
      phone_number: '+14155559876',
      label: 'SIP line',
      outbound_trunk_config: { address: 'sip.example.com' },
    });

    expect(result.isError).toBeFalsy();
    expect(captured.body).toEqual({
      provider: 'sip_trunk',
      phone_number: '+14155559876',
      label: 'SIP line',
      outbound_trunk_config: { address: 'sip.example.com' },
    });
  });

  it('import_phone_number rejects non-E.164 numbers before any upstream call', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '415-555-9876',
      label: 'Sales line',
      twilio_sid: TWILIO_SID,
      twilio_token: TWILIO_TOKEN,
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_PHONE_NUMBER' });
  });

  it('import_phone_number rejects twilio imports without credentials', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('twilio_sid');
  });

  it('import_phone_number rejects malformed Twilio credentials before any upstream call', async () => {
    // Format validation is fail-closed at the input schema: a short or
    // JSON-syntax credential must never reach the redaction path, where it
    // would double as a substring-replacement weapon against the output.
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
      twilio_sid: '"',
      twilio_token: 'x',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/twilio_sid|Account SID/);
  });

  it('import_phone_number rejects sip_trunk imports without any trunk config', async () => {
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'sip_trunk',
      phone_number: '+14155559876',
      label: 'SIP line',
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'INVALID_ARGUMENTS' });
    expect(result.json.error).toContain('inbound_trunk_config');
  });

  it('deletes a phone number and maps 404 to PHONE_NUMBER_NOT_FOUND', async () => {
    mswServer.use(...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const deleted = await testClient.callTool('delete_phone_number', { phone_number_id: 'pn_test_123' });
    expect(deleted.isError).toBeFalsy();
    expect(deleted.json.ok).toBe(true);
    expect(deleted.json.phone_number_id).toBe('pn_test_123');

    const missing = await testClient.callTool('delete_phone_number', { phone_number_id: 'trigger-404' });
    expect(missing.isError).toBe(true);
    expect(missing.json).toMatchObject({ ok: false, code: 'PHONE_NUMBER_NOT_FOUND' });
  });

  it('redacts Twilio credentials reflected in the import success payload', async () => {
    const reflecting = http.post(
      'https://api.elevenlabs.io/v1/convai/phone-numbers',
      () => HttpResponse.json({
        phone_number_id: 'pn_imported_123',
        provider: 'twilio',
        sid: TWILIO_SID,
        token: TWILIO_TOKEN,
        echoed_note: `credential ${TWILIO_TOKEN} accepted`,
      }),
    );
    mswServer.use(reflecting, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
      twilio_sid: TWILIO_SID,
      twilio_token: TWILIO_TOKEN,
    });

    expect(result.isError).toBeFalsy();
    // Credential-shaped keys are redacted by the sanitizer; the exact values are
    // stripped even when reflected under an innocent key name, and the JSON
    // structure around the redaction survives intact.
    expect(result.text).not.toContain(TWILIO_TOKEN);
    expect(result.text).not.toContain(TWILIO_SID);
    expect(result.text).toContain('[redacted]');
    expect(result.json.phone_number.phone_number_id).toBe('pn_imported_123');
  });

  it('redacts Twilio credentials quoted inside an upstream error detail', async () => {
    const failing = http.post(
      'https://api.elevenlabs.io/v1/convai/phone-numbers',
      () => HttpResponse.json(
        { detail: { message: `Twilio rejected auth token ${TWILIO_TOKEN} for account ${TWILIO_SID}` } },
        { status: 422 },
      ),
    );
    mswServer.use(failing, ...createElevenLabsAgentsHandlers());
    testClient = await createTestClient({
      env: { ELEVENLABS_API_KEY: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' },
    });

    const result = await testClient.callTool('import_phone_number', {
      provider: 'twilio',
      phone_number: '+14155559876',
      label: 'Sales line',
      twilio_sid: TWILIO_SID,
      twilio_token: TWILIO_TOKEN,
    });

    expect(result.isError).toBe(true);
    expect(result.json).toMatchObject({ ok: false, code: 'HTTP_422' });
    expect(result.text).not.toContain(TWILIO_TOKEN);
    expect(result.text).not.toContain(TWILIO_SID);
    expect(result.text).toContain('[redacted]');
  });
});

describe('redactCredentialValues', () => {
  it('redacts a valid-format credential without corrupting surrounding fields', () => {
    const out = redactCredentialValues(
      `{"phone_number_id":"pn_1","note":"imported ${TWILIO_SID} with ${TWILIO_TOKEN}"}`,
      [TWILIO_SID, TWILIO_TOKEN],
    );
    expect(out).toBe('{"phone_number_id":"pn_1","note":"imported [redacted] with [redacted]"}');
    expect(JSON.parse(out)).toEqual({
      phone_number_id: 'pn_1',
      note: 'imported [redacted] with [redacted]',
    });
  });

  it('skips secrets below the minimum length instead of corrupting the payload', () => {
    // A one-character or JSON-delimiter "secret" would otherwise replace every
    // matching byte in the serialized output; short values are skipped instead.
    const text = '{"ok":true,"note":"everything fine"}';
    expect(redactCredentialValues(text, ['"', 'x', '"ok"'])).toBe(text);
  });
});
