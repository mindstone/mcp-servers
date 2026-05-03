/**
 * HIGH-1 — `assertSlackOwnedHttpsUrl` must block any URL that is not
 * HTTPS + slack.com / *.slack.com before sending the bearer token. Slack
 * API responses are an untrusted-input surface; an attacker who can
 * influence `url_private_download` could otherwise exfiltrate the
 * workspace bot token to a server they control.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('assertSlackOwnedHttpsUrl — bearer-token exfiltration defence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function load() {
    return await import('../src/utils.js');
  }

  it('passes HTTPS + slack.com', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() => assertSlackOwnedHttpsUrl('https://slack.com/files/T123/F456')).not.toThrow();
  });

  it('passes HTTPS + files.slack.com', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() =>
      assertSlackOwnedHttpsUrl('https://files.slack.com/files-pri/T123-F456/download/x.txt'),
    ).not.toThrow();
  });

  it('passes HTTPS + *.slack.com subdomain', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() =>
      assertSlackOwnedHttpsUrl('https://edge.slack.com/some/path'),
    ).not.toThrow();
  });

  it('BLOCKS lookalike host like evil.slack.com.attacker.com', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() =>
      assertSlackOwnedHttpsUrl('https://evil.slack.com.attacker.com/foo'),
    ).toThrow(/SLACK_FILE_URL_UNTRUSTED|outside the slack\.com domain/);
  });

  it('BLOCKS HTTP scheme even if hostname is slack.com', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() => assertSlackOwnedHttpsUrl('http://slack.com/files/T123/F456')).toThrow(
      /non-HTTPS|SLACK_FILE_URL_UNTRUSTED/,
    );
  });

  it('BLOCKS arbitrary attacker.com host', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() => assertSlackOwnedHttpsUrl('https://attacker.com/exfil')).toThrow(
      /outside the slack\.com domain|SLACK_FILE_URL_UNTRUSTED/,
    );
  });

  it('BLOCKS malformed URL gracefully (no crash)', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    expect(() => assertSlackOwnedHttpsUrl('not a url')).toThrow(
      /malformed|SLACK_FILE_URL_UNTRUSTED/,
    );
  });

  it('user-facing error never includes the bearer token', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    let caught: { message?: string; resolution?: string } | null = null;
    try {
      assertSlackOwnedHttpsUrl('https://attacker.com/bait');
    } catch (err) {
      caught = err as { message?: string; resolution?: string };
    }
    expect(caught).toBeTruthy();
    // Defence-in-depth: even if a future caller mis-includes a bearer in
    // some upstream message, the thrown user-facing strings must not
    // contain `Bearer`-prefixed credentials.
    expect(caught!.message?.toLowerCase()).not.toContain('bearer');
    expect(caught!.resolution?.toLowerCase()).not.toContain('bearer');
  });

  it('logs the BLOCKED hostname to stderr for ops detection', async () => {
    const { assertSlackOwnedHttpsUrl } = await load();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      assertSlackOwnedHttpsUrl('https://attacker.com/x');
    } catch {
      // expected
    }
    const all = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(all).toContain('BLOCKED untrusted file URL');
    expect(all).toContain('attacker.com');
  });
});
