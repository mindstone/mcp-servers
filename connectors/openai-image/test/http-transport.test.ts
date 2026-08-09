/**
 * Regression test for the HTTP transport's request-body handling
 * (`readJsonBody`): bodies accumulate in memory before SDK validation runs,
 * so any loopback client passing `isLoopbackHost` could OOM the process with
 * an unbounded body. The reader must reject over-limit bodies (and destroy
 * the request) while leaving ordinary JSON-RPC envelopes untouched.
 */

import { Readable } from 'node:stream';
import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { importConnectorModule } from './helpers.js';

const makeRequest = (chunks: Buffer[]): http.IncomingMessage => {
  const req = Readable.from(chunks) as http.IncomingMessage;
  req.method = 'POST';
  return req;
};

describe('readJsonBody — request body byte bound', () => {
  it('parses an ordinary JSON body', async () => {
    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-Acme-read-json-body',
    });
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await expect(connector.readJsonBody(makeRequest([body]))).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
  });

  it('rejects a body over the byte cap instead of buffering it', async () => {
    const connector = await importConnectorModule({
      OPENAI_API_KEY: 'sk-test-Acme-read-json-body-cap',
    });
    // Two chunks that cross the 4 MB cap only in aggregate.
    const req = makeRequest([Buffer.alloc(3 * 1024 * 1024, 1), Buffer.alloc(2 * 1024 * 1024, 1)]);
    await expect(connector.readJsonBody(req)).rejects.toThrow('Request body too large');
    expect(req.destroyed).toBe(true);
  });
});
