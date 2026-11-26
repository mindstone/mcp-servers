import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { it } from 'vitest';
import { createKeepAliveFixture, KEEP_ALIVE, OFFICE_SERVER, proof, safeRun } from './fixtures/keep-alive.js';

async function withServer(name: string, serveCall: boolean): Promise<void> {
  await safeRun(name, async () => {
    const fixture = await createKeepAliveFixture();
    const transport = new StdioClientTransport({
      command: process.execPath, args: [OFFICE_SERVER], env: fixture.env, stderr: 'pipe',
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'office-keep-alive-test', version: '0.0.0' });
    try {
      if (serveCall) await fixture.startManagedHelper();
      await client.connect(transport);
      if (serveCall) {
        const result = await client.callTool({ name: 'rebel_office_setup', arguments: { action: 'install' } });
        // Identify before checking the result so a wrong result still has owned cleanup.
        await fixture.identify();
        fixture.linuxSetupResult(result);
        proof('baseline-complete', { case: name, pid: fixture.pid!, sdk: '1.32.2' });
      } else {
        fixture.check('sdk-declares-keep-alive', Object.hasOwn(client.getServerCapabilities()?.experimental ?? {}, KEEP_ALIVE));
      }
    } finally {
      try {
        await client.close();
      } finally {
        // Plain SDK close is not a product cleanup guarantee: explicitly stop the identified orphan.
        await fixture.cleanup();
      }
    }
  });
}

it('declares keep-alive through the real SDK initialize response', () => withServer('declaration', false));
it.skipIf(process.platform !== 'linux')('serves setup with a healthy identified helper and real pane HTML', () => withServer('served-call', true));
