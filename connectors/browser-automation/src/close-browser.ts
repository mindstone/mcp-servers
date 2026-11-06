/**
 * Run by the server in a detached process when the host stops it, so closing
 * the browser can finish after the server has gone (see closeBrowserOnStop).
 */
import { closeBrowserForGood } from './browser-client.js';

await closeBrowserForGood();
process.exit(0);
