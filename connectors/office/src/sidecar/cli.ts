#!/usr/bin/env node

/**
 * CLI entry point for the Office sidecar server.
 *
 * Usually spawned by Rebel's officeSidecarManager as a child process.
 * The MCP server can still invoke it as a lazy fallback safety net.
 * Reads configuration from environment variables, starts the sidecar,
 * and outputs the connection details as JSON to stdout.
 *
 * Environment variables:
 *   MCP_OFFICE_SIDECAR_STATE_DIR — Required. Directory for state file, certs, and manifests.
 *   MCP_OFFICE_ADDIN_DIR         — Optional. Path to built add-in static files.
 */

import { startOfficeSidecar } from './index.js';
import type { ReadySignal } from '../shared/sidecar/readySignal.js';

process.on('disconnect', () => {
  process.exit(0);
});

const stateDir = process.env['MCP_OFFICE_SIDECAR_STATE_DIR'];
if (!stateDir) {
  console.error('[office-sidecar-cli] MCP_OFFICE_SIDECAR_STATE_DIR is required');
  process.exit(1);
}

const addinDir = process.env['MCP_OFFICE_ADDIN_DIR'];

try {
  const sidecar = await startOfficeSidecar({
    stateDirectory: stateDir,
    ...(addinDir ? { addinDir } : {}),
  });

  // Output connection details as JSON on stdout for the parent process to read.
  // The parent (officeSidecarManager) parses this to know the sidecar is ready.
  const info: ReadySignal = {
    type: 'ready',
    port: sidecar.port,
    token: sidecar.token,
    pid: sidecar.pid,
    stateFilePath: sidecar.stateFilePath,
    wefInstallResults: sidecar.wefInstallResults,
  };
  process.stdout.write(JSON.stringify(info) + '\n');

  console.error(`[office-sidecar-cli] Ready on https://127.0.0.1:${sidecar.port}`);
  if (sidecar.wefInstallResults && sidecar.wefInstallResults.length > 0) {
    const summary = sidecar.wefInstallResults
      .map((r) => `${r.app}=${r.status}${r.error ? ` (${r.error})` : ''}`)
      .join(', ');
    console.error(`[office-sidecar-cli] Manifest install: ${summary}`);
  }

  // Graceful shutdown on signals
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`[office-sidecar-cli] Received ${signal}, shutting down`);
    await sidecar.stop();
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
} catch (error) {
  console.error('[office-sidecar-cli] Failed to start', error);
  process.exit(1);
}
