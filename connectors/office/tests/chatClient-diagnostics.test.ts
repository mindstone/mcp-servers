import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('office chatClient diagnostics', () => {
  it('installs a reusable __rebelDiag API backed by the live taskpane ring buffer', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === '/diag/log') {
        return new Response('', { status: 204 });
      }
      return new Response(
        JSON.stringify({
          conversationId: 'conv-stage-11',
          state: 'new',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();

    const { createConversation, installTaskpaneDiagnosticGlobal } = await import(
      '../src/addin/chatClient.js'
    );

    const target: {
      __rebelDiag?: {
        dump(): Array<{ kind: string; requestId: string }>;
        dumpById(requestId: string): Array<{ kind: string; requestId: string }>;
        clear(): void;
        tailId(): string | null;
      };
    } = {};
    const diagApi = installTaskpaneDiagnosticGlobal(target);
    diagApi.clear();

    await expect(
      createConversation({
        sidecarToken: 'sidecar-token',
        intent: 'chat',
        userText: 'hello from diagnostics',
      }),
    ).resolves.toMatchObject({
      ok: true,
      conversationId: 'conv-stage-11',
    });

    expect(target.__rebelDiag).toBe(diagApi);

    const events = diagApi.dump();
    expect(events.map((event) => event.kind)).toEqual([
      'fetch.start',
      'fetch.response',
    ]);

    const requestId = diagApi.tailId();
    expect(requestId).toBeTypeOf('string');
    expect(diagApi.dumpById(requestId!)).toHaveLength(2);

    diagApi.clear();
    expect(diagApi.dump()).toEqual([]);
  });
});
