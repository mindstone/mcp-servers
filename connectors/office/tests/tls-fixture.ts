// Shared synthetic-TLS fixture for the office test suite.
//
// The office sidecar starts an HTTPS listener via Microsoft's
// `office-addin-dev-certs`. In tests that package is fully mocked (see
// `tests/setup.ts`) so neither the system keychain nor `sudo` is ever touched;
// the mock instead serves a synthetic self-signed cert/key pair generated here.
//
// WHY GENERATION LIVES IN A SINGLE PLACE, RUN ONCE
// ------------------------------------------------
// This pair is generated exactly once per `vitest` run from `globalSetup`
// (`tests/global-setup.ts`), which runs in the parent process *before any
// worker spawns*. Generating it from `setupFiles` instead — as the suite used
// to — runs the generator once per worker, in parallel, all racing to write the
// same two files in a shared tmpdir. The existence-only guard plus the
// non-atomic two-file `openssl` write could then leave a torn pair on disk
// (cert from generation A, key from generation B). The mock would hand that
// mismatched pair to `https.createServer`, which throws
// `ERR_OSSL_X509_KEY_VALUES_MISMATCH` for every test in the file — a cold-cache
// flake that reproduced on roughly a third of CI runs.
//
// Centralising generation in `globalSetup` removes the concurrency. The atomic
// publish (write to a pid-scoped temp path, then rename into place) and the
// self-validation below are defence-in-depth: they also self-heal a torn pair
// left behind on a developer box by an older version of this code or an
// interrupted run.

import { execFile } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const TLS_DIR = join(tmpdir(), 'mcp-office-test-tls');
export const TLS_CERT = join(TLS_DIR, 'localhost-cert.pem');
export const TLS_KEY = join(TLS_DIR, 'localhost-key.pem');

/**
 * True iff `keyPem` is the private key corresponding to `certPem`'s public key.
 * This is precisely the invariant `https.createServer` enforces internally, so
 * checking it up front lets us fail loudly with a clear message instead of
 * surfacing a cryptic `ERR_OSSL_X509_KEY_VALUES_MISMATCH` deep in a listener.
 */
export function certKeyPairMatches(certPem: Buffer, keyPem: Buffer): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

async function readPairIfValid(): Promise<boolean> {
  try {
    const [cert, key] = await Promise.all([readFile(TLS_CERT), readFile(TLS_KEY)]);
    return certKeyPairMatches(cert, key);
  } catch {
    return false;
  }
}

/**
 * Ensure a valid synthetic cert/key pair exists at the shared paths above.
 * Idempotent and safe to call repeatedly; reuses an existing *valid* pair and
 * regenerates only when the pair is missing or torn. Intended to be called once
 * from `globalSetup` — not from per-worker `setupFiles`.
 */
export async function ensureTlsFixture(): Promise<void> {
  await mkdir(TLS_DIR, { recursive: true });
  // Legacy workaround (predates the mock): pre-create the real dev-certs dir so
  // the library's `deleteCertificateFiles()` scandir never ENOENT-crashes. The
  // module is fully mocked now, but this is cheap and kept for parity.
  await mkdir(join(homedir(), '.office-addin-dev-certs'), { recursive: true });

  if (await readPairIfValid()) return;

  // Generate into pid-scoped temp files, then atomically rename into place.
  // 100-year validity so the fixture never silently expires on long-lived boxes.
  const tmpCert = `${TLS_CERT}.${process.pid}.tmp`;
  const tmpKey = `${TLS_KEY}.${process.pid}.tmp`;
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-keyout', tmpKey,
    '-out', tmpCert,
    '-days', '36500',
    '-nodes',
    '-subj', '/CN=localhost/O=Office Test Fixture',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ]);
  await rename(tmpKey, TLS_KEY);
  await rename(tmpCert, TLS_CERT);

  if (!(await readPairIfValid())) {
    throw new Error(
      '[office tests] generated TLS fixture failed self-validation — see tests/tls-fixture.ts',
    );
  }
}
