import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Workaround for office-addin-dev-certs@2.0.7: the install flow calls
// deleteCertificateFiles() which scandirs ~/.office-addin-dev-certs without
// guarding for ENOENT. On a fresh CI runner where that dir doesn't exist,
// any test that boots the sidecar (and therefore calls getHttpsServerOptions)
// races: whichever test gets there first crashes with ENOENT. Pre-creating
// the dir makes the test suite deterministic without changing product
// behaviour. mkdir recursive is idempotent so this is safe across workers.
//
// Remove once the upstream library lands an existence check (no fix on main
// as of 2.0.7 — see node_modules/office-addin-dev-certs/src/uninstall.ts).
await mkdir(join(homedir(), '.office-addin-dev-certs'), { recursive: true });
