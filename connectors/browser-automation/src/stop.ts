import { closeBrowserOnStop } from './browser-client.js';

/**
 * Close the browser when the host stops this server: the host ends our stdin
 * (the MCP stdio stop order) or sends SIGTERM/SIGINT. Runs once, then exits,
 * leaving a separate process to finish closing the browser.
 */
export function closeBrowserWhenHostStops(
  stdin: NodeJS.EventEmitter = process.stdin,
  signals: NodeJS.EventEmitter = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    closeBrowserOnStop()
      .catch((error: unknown) => {
        console.error('Could not close the browser while stopping:', error instanceof Error ? error.message : error);
      })
      .finally(() => exit(0));
  };
  stdin.once('end', stop);
  stdin.once('close', stop);
  signals.once('SIGTERM', stop);
  signals.once('SIGINT', stop);
}
