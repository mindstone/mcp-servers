import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { refuseRedirects } from '../src/fetch-policy.js';

// A computer's endpoint redirecting to something on the host's own network must get nothing back.
describe('the connector refuses every redirect, including requests the E2B SDK makes', () => {
  let hostOnly: Server;
  let computer: Server;
  let computerUrl = '';
  beforeAll(async () => {
    hostOnly = createHttpServer((_, res) => res.end('HOST-ONLY-SENTINEL'));
    await new Promise<void>((r) => hostOnly.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(hostOnly.address() as AddressInfo).port}/host-only`;
    computer = createHttpServer((_, res) => res.writeHead(302, { Location: target }).end());
    await new Promise<void>((r) => computer.listen(0, '127.0.0.1', r));
    computerUrl = `http://127.0.0.1:${(computer.address() as AddressInfo).port}/files`;
    refuseRedirects();
  });
  afterAll(() => {
    hostOnly.close();
    computer.close();
  });

  it('fails a redirect even when the caller asks to follow it', async () => {
    await expect(fetch(computerUrl, { redirect: 'follow' })).rejects.toThrow();
    await expect(fetch(new Request(computerUrl, { redirect: 'follow' }))).rejects.toThrow();
  });

  it("fails it through undici's own fetch, imported the way the E2B SDK imports it", async () => {
    const undici = (await import('undici')) as unknown as { fetch: typeof fetch; Agent: new () => object };
    // Exactly the SDK's call shape: undici.fetch with its own dispatcher and redirect "follow".
    await expect(undici.fetch(computerUrl, { redirect: 'follow', dispatcher: new undici.Agent() } as RequestInit)).rejects.toThrow();
  });
});
