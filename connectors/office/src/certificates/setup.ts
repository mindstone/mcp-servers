import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { deleteCertificateFiles, generateCertificates } from 'office-addin-dev-certs';
import * as defaults from 'office-addin-dev-certs/lib/defaults.js';
import { readCertificatePair, verifyEffectiveTrust, type CertificateCommand } from './effectiveTrust.js';
import { runCertificateCommand } from './ownedCommand.js';
import { CERT_APPROVAL_TIMEOUT_MS, isRebelCertificateOwner } from './ownership.js';

const CERT_VERIFY_TIMEOUT_MS = 15_000;

function setupCauseCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' && Number.isInteger(code)) return `exit-${code}`;
  if (typeof code === 'string' && /^(?:E[A-Z0-9_]{1,30}|ABORT_ERR|timeout|aborted|negative)$/.test(code)) return code;
  return 'unknown';
}

function certificateSetupError(): Error & { code: string } {
  const fix = isRebelCertificateOwner()
    ? 'Choose Try again on the Microsoft Office card in Settings and approve the certificate prompt.'
    : 'Run the Microsoft Office connector again and approve the certificate prompt.';
  return Object.assign(new Error(`CERT_NOT_TRUSTED: The local security certificate is not ready. ${fix}`), { code: 'CERT_NOT_TRUSTED' });
}

/** Standalone owns one install attempt; managed helpers only read the existing pair. */
export async function getSidecarHttpsOptions(options: {
  signal?: AbortSignal | undefined;
} = {}): Promise<{ ca: Buffer; cert: Buffer; key: Buffer }> {
  const paths = defaults;
  try {
    if (!isRebelCertificateOwner()) {
      const platform = process.platform;
      const verifyRun: CertificateCommand = (file, args) => runCertificateCommand(file, args, { timeoutMs: CERT_VERIFY_TIMEOUT_MS, signal: options.signal });
      const verify = (): Promise<boolean> => verifyEffectiveTrust({ ...paths, platform, certificateName: defaults.certificateName, run: verifyRun });
      // An inconclusive pre-check still gets one install attempt; only the post-check is terminal.
      const trusted = await verify().catch((error: unknown) => {
        options.signal?.throwIfAborted();
        if ((error as { code?: unknown } | null)?.code === 'CERT_FILES_UNREADABLE') throw error;
        return false;
      });
      if (!trusted) {
        const installRun: CertificateCommand = (file, args) => runCertificateCommand(file, args, { timeoutMs: CERT_APPROVAL_TIMEOUT_MS, signal: options.signal });
        const require = createRequire(import.meta.url);
        const scripts = path.join(path.dirname(require.resolve('office-addin-dev-certs/package.json')), 'scripts');
        const psArgs = (name: string, args: string[]): string[] => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, name), ...args];
        if (platform === 'win32') await installRun('powershell', psArgs('uninstall.ps1', ['CurrentUser', defaults.certificateName]));
        options.signal?.throwIfAborted();
        deleteCertificateFiles(path.dirname(paths.caCertificatePath));
        await generateCertificates(paths.caCertificatePath, paths.localhostCertificatePath, paths.localhostKeyPath, defaults.daysUntilCertificateExpires, defaults.domain);
        options.signal?.throwIfAborted();
        if (platform === 'darwin') {
          await installRun('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db'), paths.caCertificatePath]);
        } else if (platform === 'win32') {
          await installRun('powershell', psArgs('install.ps1', ['CurrentUser', paths.caCertificatePath]));
        } else if (platform === 'linux') {
          await installRun('sudo', ['sh', path.join(scripts, 'install_linux.sh'), paths.caCertificatePath]);
        } else {
          throw new Error('Automatic certificate installation is not supported on this platform.');
        }
        if (!await verify()) throw Object.assign(certificateSetupError(), { cause: { code: 'negative' } });
      }
    }
    const pair = readCertificatePair(paths);
    if (!pair) throw Object.assign(certificateSetupError(), { cause: { code: 'negative' } });
    return pair;
  } catch (error) {
    const cause = (error as { cause?: unknown } | null)?.cause ?? error;
    process.stderr.write(`[office-cert] setup-failed cause=${options.signal?.aborted ? 'aborted' : setupCauseCode(cause)}\n`);
    throw certificateSetupError();
  }
}
