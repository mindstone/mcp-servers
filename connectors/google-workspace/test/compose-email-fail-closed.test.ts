import { describe, it, expect } from 'vitest';
import { handleComposeWorkspaceEmail } from '../src/tools/gmail-handlers.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

describe('handleComposeWorkspaceEmail input validation (fail-closed gate)', () => {
  const expectInvalidParams = async (params: any) => {
    await expect(handleComposeWorkspaceEmail(params)).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
    await expect(handleComposeWorkspaceEmail(params)).rejects.toBeInstanceOf(McpError);
  };

  it('throws InvalidParams when called with empty args object', async () => {
    await expectInvalidParams({});
  });

  it('throws InvalidParams when "to" is missing', async () => {
    await expectInvalidParams({ subject: 'Hi', body: 'Hello' });
  });

  it('throws InvalidParams when "to" is null', async () => {
    await expectInvalidParams({ to: null, subject: 'Hi', body: 'Hello' });
  });

  it('throws InvalidParams when every recipient is empty/whitespace', async () => {
    await expectInvalidParams({ to: ['', '   ', '\t'], subject: 'Hi', body: 'Hello' });
  });

  it('throws InvalidParams when "subject" is missing', async () => {
    await expectInvalidParams({ to: ['a@b.com'], body: 'Hello' });
  });

  it('throws InvalidParams when "subject" is empty string', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: '', body: 'Hello' });
  });

  it('throws InvalidParams when "subject" is whitespace-only', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: '   ', body: 'Hello' });
  });

  it('throws InvalidParams when "subject" is a non-string type', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: 42, body: 'Hello' });
  });

  it('throws InvalidParams when "body" is missing', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: 'Hi' });
  });

  it('throws InvalidParams when "body" is empty string', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: 'Hi', body: '' });
  });

  it('throws InvalidParams when "body" is whitespace-only', async () => {
    await expectInvalidParams({ to: ['a@b.com'], subject: 'Hi', body: '   \n\t ' });
  });

  it('error message names all three required fields', async () => {
    try {
      await handleComposeWorkspaceEmail({} as any);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const msg = (err as Error).message;
      expect(msg).toContain('to');
      expect(msg).toContain('subject');
      expect(msg).toContain('body');
    }
  });

  it('passes the gate with mixed valid+empty recipients (filters empties)', async () => {
    // The gate should not throw when at least one recipient is non-empty after filtering;
    // downstream init/auth resolution will fail in this test environment, but the gate
    // itself must permit the call through.
    await expect(
      handleComposeWorkspaceEmail({
        to: ['', 'a@b.com', '  '],
        subject: 'Hi',
        body: 'Hello',
      } as any),
    ).rejects.not.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  it('passes the gate with fully populated args (downstream auth error expected)', async () => {
    await expect(
      handleComposeWorkspaceEmail({
        to: ['a@b.com'],
        subject: 'Hi',
        body: 'Hello',
      } as any),
    ).rejects.not.toMatchObject({ code: ErrorCode.InvalidParams });
  });
});
