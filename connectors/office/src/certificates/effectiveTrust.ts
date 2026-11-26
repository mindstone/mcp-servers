import fs from 'node:fs';
import { z } from 'zod';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export interface CertificatePaths {
  caCertificatePath: string;
  localhostCertificatePath: string;
  localhostKeyPath: string;
}

export type CertificateCommand = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

/** Absence and malformed material are negative; unreadable files are unknown (throw). */
export function readCertificatePair(paths: CertificatePaths): { ca: Buffer; cert: Buffer; key: Buffer } | null {
  const read = (file: string): Buffer | null => {
    try { return fs.readFileSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw Object.assign(new Error(`Couldn't read the security certificate files (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`), { code: 'CERT_FILES_UNREADABLE', cause: error });
    }
  };
  // Read all files, so absence cannot conceal a permissions/I/O failure in another file.
  const ca = read(paths.caCertificatePath);
  const cert = read(paths.localhostCertificatePath);
  const key = read(paths.localhostKeyPath);
  if (!ca || !cert || !key) return null;
  try {
    const probe = Buffer.from('office-local-certificate');
    if (!crypto.privateDecrypt(key, crypto.publicEncrypt(cert, probe)).equals(probe)) return null;
  } catch { return null; } // Malformed or mismatched PEM, not an I/O failure.
  return { ca, cert, key };
}

/**
 * Read-only, effective OS trust. False is definite negative; a rejected check is unknown.
 * The caller owns the async command, its deadline, cancellation and child cleanup.
 */
export async function verifyEffectiveTrust(options: CertificatePaths & {
  platform: NodeJS.Platform;
  certificateName: string;
  run: CertificateCommand;
}): Promise<boolean> {
  if (!readCertificatePair(options)) return false;
  if (options.platform === 'darwin') {
    try {
      await options.run('security', ['verify-cert', '-c', options.localhostCertificatePath, '-p', 'ssl', '-s', 'localhost']);
      return true;
    } catch (error) {
      const result = error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof result.code === 'number' && /CSSMERR_TP_NOT_TRUSTED|CSSMERR_TP_CERT_EXPIRED|CSSMERR_TP_INVALID_ANCHOR_CERT|certificate (?:is )?not trusted/i.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return false;
      throw error;
    }
  }
  if (options.platform === 'win32') {
    const marker = `[office-cert-${crypto.randomUUID()}]`;
    const { stdout } = await options.run('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./verify.ps1', import.meta.url)),
      '-CaCertificateName', options.certificateName,
      '-CaCertificatePath', options.caCertificatePath,
      '-LocalhostCertificatePath', options.localhostCertificatePath,
      '-OutputMarker', marker,
    ]);
    const index = stdout.lastIndexOf(marker);
    if (index !== -1) {
      const verdict = stdout.slice(index + marker.length).trim();
      try {
        const result = z.object({ chainValid: z.boolean(), storeMatches: z.boolean(), issuerMatches: z.boolean(), chainStatus: z.unknown().optional() }).strict().parse(JSON.parse(verdict));
        const trusted = result.chainValid && result.storeMatches && result.issuerMatches;
        if (!trusted) {
          const status = z.union([z.array(z.unknown()), z.object({ value: z.array(z.unknown()) })]).safeParse(result.chainStatus);
          const values = status.success ? (Array.isArray(status.data) ? status.data : status.data.value) : [];
          const names = values.filter((value): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)).slice(0, 8);
          process.stderr.write(`[office-cert] chain-status=${names.join(',')}\n`);
        }
        return trusted;
      } catch { throw new Error("Couldn't read the security certificate check's result."); }
    }
    throw new Error("Couldn't read the security certificate check's result.");
  }
  if (options.platform === 'linux') {
    try {
      await options.run('openssl', ['verify', '-purpose', 'sslserver', '-verify_hostname', 'localhost', options.localhostCertificatePath]);
      return true;
    } catch (error) {
      const result = error as { code?: unknown; stderr?: string };
      if (typeof result.code === 'number' && /error (?:18|19|20|21) at \d+ depth lookup/.test(result.stderr ?? '')) return false;
      throw error;
    }
  }
  throw new Error('Automatic certificate trust is not supported on this platform.');
}
