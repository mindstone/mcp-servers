/**
 * slack-010 — `download_slack_file` must NOT replay the workspace bearer
 * token against a non-Slack redirect target. AGENTS.md invariant #7
 * explicitly bans auto-follow on downloads. Node's global `fetch` defaults
 * to `redirect: 'follow'`, so the file-download path must opt out and
 * re-validate every hop before reissuing the authenticated request.
 */
import { describe, it, expect, vi } from 'vitest';

import { fetchSlackFileFollowingSlackRedirects } from '../src/tools/files.js';

function buildResponse(init: { status?: number; headers?: Record<string, string>; body?: string }): Response {
  return new Response(init.body ?? '', {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe('fetchSlackFileFollowingSlackRedirects', () => {
  it('passes the bearer token on the first hop and returns the response on 200', async () => {
    const calls: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: typeof url === 'string' ? url : url.toString(),
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
        redirect: init?.redirect,
      });
      return buildResponse({ status: 200, body: 'ok' });
    });

    const res = await fetchSlackFileFollowingSlackRedirects(
      'https://files.slack.com/files-pri/T1-F1/download/x.txt',
      'xoxb-secret-token',
      fetchMock as unknown as typeof fetch,
      new AbortController().signal,
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe('Bearer xoxb-secret-token');
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('re-validates the redirect target and DOES send the bearer token to another slack.com host', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({
        url: u,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      });
      if (u.includes('slack.com/files-pri/')) {
        return buildResponse({
          status: 302,
          headers: { location: 'https://files-edge.slack.com/redirected/T1-F1' },
        });
      }
      return buildResponse({ status: 200, body: 'content' });
    });

    const res = await fetchSlackFileFollowingSlackRedirects(
      'https://files.slack.com/files-pri/T1-F1/download/x.txt',
      'xoxb-secret-token',
      fetchMock as unknown as typeof fetch,
      new AbortController().signal,
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.auth).toBe('Bearer xoxb-secret-token');
    expect(calls[1]?.url).toBe('https://files-edge.slack.com/redirected/T1-F1');
    expect(calls[1]?.auth).toBe('Bearer xoxb-secret-token');
  });

  it('rejects a redirect to a non-Slack host BEFORE sending the bearer token to it', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      calls.push({
        url: u,
        auth: (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
      });
      if (u.includes('slack.com')) {
        return buildResponse({
          status: 302,
          headers: { location: 'https://attacker.example/steal' },
        });
      }
      // If the helper bug-replayed the token, this branch would fire.
      return buildResponse({ status: 200, body: 'stolen' });
    });

    await expect(
      fetchSlackFileFollowingSlackRedirects(
        'https://files.slack.com/files-pri/T1-F1/download/x.txt',
        'xoxb-secret-token',
        fetchMock as unknown as typeof fetch,
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/SLACK_FILE_URL_UNTRUSTED|slack/i);

    // The bearer token was sent on the FIRST hop only (the original Slack URL).
    // The helper MUST refuse to make a second request to attacker.example.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://files.slack.com/files-pri/T1-F1/download/x.txt');
    expect(calls.find((c) => c.url.includes('attacker.example'))).toBeUndefined();
  });

  it('rejects a redirect to evilslack.com (suffix-bypass attempt)', async () => {
    const fetchMock = vi.fn(async () =>
      buildResponse({
        status: 302,
        headers: { location: 'https://evilslack.com/steal' },
      }),
    );

    await expect(
      fetchSlackFileFollowingSlackRedirects(
        'https://files.slack.com/files-pri/T1-F1/download/x.txt',
        'xoxb-secret-token',
        fetchMock as unknown as typeof fetch,
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/SLACK_FILE_URL_UNTRUSTED|slack/i);
  });

  it('refuses to follow a redirect chain longer than the configured maximum', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      // Always redirect within slack.com to a slightly different path so each
      // hop validates but the chain is infinite.
      const hop = Number.parseInt(/hop-(\d+)/.exec(u)?.[1] ?? '0', 10);
      return buildResponse({
        status: 302,
        headers: { location: `https://files.slack.com/loop/hop-${hop + 1}` },
      });
    });

    await expect(
      fetchSlackFileFollowingSlackRedirects(
        'https://files.slack.com/loop/hop-0',
        'xoxb-secret-token',
        fetchMock as unknown as typeof fetch,
        new AbortController().signal,
      ),
    ).rejects.toThrowError(/redirect chain exceeded/);
  });
});
