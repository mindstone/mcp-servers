import { describe, expect, it, afterEach, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { handleComposeEmail } from '../src/compose.js';

// Direct handler tests (no server fixture): compose_email must fail closed on
// missing draft content — an editable draft with nothing to review is worse
// than an error — and the McpError must surface as-is, not as an auth-flavoured
// retry envelope (the handler is deliberately not wrapped in withErrorHandling).

const SENDER = 'sender@example.com';

describe('handleComposeEmail fail-closed validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const expectInvalidParams = async (params: unknown) => {
    const promise = handleComposeEmail(params as Parameters<typeof handleComposeEmail>[0]);
    await expect(promise).rejects.toBeInstanceOf(McpError);
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  };

  it('rejects empty arguments', async () => {
    await expectInvalidParams({});
  });

  it('rejects a missing or empty recipient list', async () => {
    await expectInvalidParams({ subject: 'Hi', body: 'There' });
    await expectInvalidParams({ to: [], subject: 'Hi', body: 'There' });
    await expectInvalidParams({ to: null, subject: 'Hi', body: 'There' });
  });

  it('rejects whitespace-only recipients', async () => {
    await expectInvalidParams({ to: ['   '], subject: 'Hi', body: 'There' });
  });

  it('rejects a missing, empty, whitespace, or non-string subject', async () => {
    await expectInvalidParams({ to: ['ada@example.com'], body: 'There' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: '', body: 'There' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: '   ', body: 'There' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: 42, body: 'There' });
  });

  it('rejects a missing, empty, whitespace, or non-string body', async () => {
    await expectInvalidParams({ to: ['ada@example.com'], subject: 'Hi' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: 'Hi', body: '' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: 'Hi', body: '   ' });
    await expectInvalidParams({ to: ['ada@example.com'], subject: 'Hi', body: { html: 'x' } });
  });

  it('resolves the sender from MS_ACCOUNT_EMAIL, trimmed', async () => {
    vi.stubEnv('MS_ACCOUNT_EMAIL', `  ${SENDER}  `);
    const result = await handleComposeEmail({
      to: ['ada@example.com'],
      subject: 'Hi',
      body: 'There',
    });
    expect(result.structuredContent.email).toBe(SENDER);
  });

  it('falls back to an empty sender when MS_ACCOUNT_EMAIL is unset, engaging the From-missing helper', async () => {
    vi.stubEnv('MS_ACCOUNT_EMAIL', '');
    const result = await handleComposeEmail({
      to: ['ada@example.com'],
      subject: 'Hi',
      body: 'There',
    });
    expect(result.structuredContent.email).toBe('');
  });
});
