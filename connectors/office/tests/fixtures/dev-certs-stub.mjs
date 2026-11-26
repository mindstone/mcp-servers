import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function getHttpsServerOptions() {
  const certPath = process.env.OFFICE_TEST_TLS_CERT;
  const keyPath = process.env.OFFICE_TEST_TLS_KEY;
  if (!certPath || !keyPath || !isAbsolute(certPath) || !isAbsolute(keyPath)) {
    throw new Error('Office test TLS requires two explicit absolute paths');
  }
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) {
    throw new Error('Office test TLS pair does not match');
  }
  return { ca: cert, cert, key };
}

export async function ensureCertificatesAreInstalled() {}
export async function installCaCertificate() {}
export async function generateCertificates() {
  throw new Error('Office test certificate generation/install must not run');
}
export function deleteCertificateFiles() {}
export function isCaCertificateInstalled() { return true; }
export function verifyCertificates() { return true; }
export const outputMarker = '';
export async function uninstallCaCertificate() {
  throw new Error('Office test certificate uninstall must not run');
}
