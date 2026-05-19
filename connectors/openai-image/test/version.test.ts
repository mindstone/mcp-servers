import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryClientPair, importConnectorModule } from './helpers.js';

describe('server version wiring', () => {
  it('uses package.json version for the MCP server implementation', async () => {
    const connector = await importConnectorModule();
    const packageJsonPath = path.join(import.meta.dirname, '..', 'package.json');
    const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonRaw) as { version: string };

    const server = connector.createServer();
    const pair = await createInMemoryClientPair(server);

    try {
      const serverVersion = pair.client.getServerVersion();
      expect(serverVersion?.version).toBe(packageJson.version);
      expect(connector.SERVER_VERSION).toBe(packageJson.version);
    } finally {
      await pair.close();
    }
  });
});
