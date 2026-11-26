export const CERT_APPROVAL_TIMEOUT_MS = 300_000;
export const isRebelCertificateOwner = (): boolean => process.env['MCP_OFFICE_CERT_OWNER'] === 'rebel';
