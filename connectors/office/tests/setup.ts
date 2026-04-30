import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { vi } from 'vitest';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// office-addin-dev-certs test isolation (m2-0-office-test-isolation)
// ---------------------------------------------------------------------------
// The office sidecar uses Microsoft's `office-addin-dev-certs@2.0.7` to
// generate a trusted localhost cert. There are TWO ways letting the real
// implementation run during tests can wedge the suite:
//
//   1. (Original) On a fresh runner, `deleteCertificateFiles()` scandirs
//      ~/.office-addin-dev-certs without guarding for ENOENT. The first test
//      that boots the sidecar races other workers and crashes. We pre-create
//      the directory below to keep that workaround in place for parity.
//
//   2. (NEW) On any machine that has previously installed the "Developer CA
//      for Microsoft Office Add-ins" into the user keychain (i.e. anyone who
//      has ever run office tests on this box), `ensureCertificatesAreInstalled()`
//      decides the existing cert is stale and calls `uninstallCaCertificate()`,
//      which runs `sudo sh scripts/uninstall.sh ...`. In a non-interactive
//      shell (CI, `npm test` from a script, milestone-end scrutiny sweeps,
//      `m3-final-regression-gate`), sudo prompts for a password and fails —
//      35 of 82 office tests fail with `Unable to uninstall the CA certificate.`
//
// Fix: vi.mock the entire `office-addin-dev-certs` module at test setup time so
// neither the keychain nor sudo is ever touched. The mock returns a synthetic
// `{ ca, cert, key }` triple. To avoid checking a private key into the repo
// (root .gitignore deliberately blocks `*.pem`/`*.key`, and the secret
// scanner correctly flags inline PEMs), we generate the synthetic pair at
// suite-start time via `openssl` into the OS temp dir. openssl is universally
// available on dev boxes (macOS) and CI runners (GitHub Actions); the
// generation is idempotent across runs (we reuse if both files already
// exist). The synthetic cert is sufficient for the office sidecar's HTTPS
// listener to start; tests connect with `rejectUnauthorized: false`, so the
// synthetic CA chain is accepted.
//
// The mock also stubs `uninstallCaCertificate` to throw if it is ever called —
// this guarantees no real uninstall path runs during the suite. Removing this
// mock would re-introduce the sudo-prompt failure.
// ---------------------------------------------------------------------------

const TLS_DIR = join(tmpdir(), 'mcp-office-test-tls');
const TLS_CERT = join(TLS_DIR, 'localhost-cert.pem');
const TLS_KEY = join(TLS_DIR, 'localhost-key.pem');

// (1) Pre-create the dev-certs directory (legacy workaround — see commit 2bc7266).
await mkdir(join(homedir(), '.office-addin-dev-certs'), { recursive: true });

// (2) Generate a synthetic self-signed RSA-2048 cert+key in tmpdir on first
//     run. Reused across runs in the same machine session. 100-year validity
//     so the fixture never silently expires on long-lived dev boxes.
await mkdir(TLS_DIR, { recursive: true });
let tlsAlreadyOnDisk = true;
try {
  await access(TLS_CERT);
  await access(TLS_KEY);
} catch {
  tlsAlreadyOnDisk = false;
}
if (!tlsAlreadyOnDisk) {
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-keyout', TLS_KEY,
    '-out', TLS_CERT,
    '-days', '36500',
    '-nodes',
    '-subj', '/CN=localhost/O=Office Test Fixture',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
}

// (3) Mock office-addin-dev-certs so neither keychain nor sudo is touched.
//
// vi.mock is hoisted to the top of the file by vitest, but the factory is
// invoked lazily when the mocked module is first imported by a test. By
// then the synthetic cert/key files above have already been written, so it
// is safe to read them inside the factory.
vi.mock('office-addin-dev-certs', async () => {
  const fs = await import('node:fs/promises');
  const cert = await fs.readFile(TLS_CERT);
  const key = await fs.readFile(TLS_KEY);

  return {
    // Mirror the real lib's public surface (see node_modules/office-addin-dev-certs/lib/main.d.ts).
    // Anything that would touch the keychain or invoke sudo is short-circuited.
    getHttpsServerOptions: async () => ({ ca: cert, cert, key }),
    ensureCertificatesAreInstalled: async () => {
      /* no-op — real install path is bypassed in tests */
    },
    installCaCertificate: async () => {
      /* no-op — would prompt sudo on real install */
    },
    uninstallCaCertificate: async () => {
      // If something ever reaches the real uninstall path during tests,
      // surface it loudly rather than silently swallow it. Any developer
      // hitting this should treat it as a regression of m2-0-office-test-isolation.
      // eslint-disable-next-line no-console
      console.error('[office tests] UNINSTALL CALLED — office-addin-dev-certs mock bypassed');
      throw new Error('uninstallCaCertificate must not run in tests');
    },
    deleteCertificateFiles: () => {
      /* no-op — would scandir ~/.office-addin-dev-certs */
    },
    generateCertificates: async () => {
      /* no-op — synthetic cert is provided via getHttpsServerOptions */
    },
    isCaCertificateInstalled: () => true,
    verifyCertificates: () => true,
    outputMarker: '',
  };
});
