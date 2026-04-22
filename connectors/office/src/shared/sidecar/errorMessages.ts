export const OFFICE_SIDECAR_ERROR_CODES = [
  'port-in-use',
  'cert-failed',
  'wef-install-failed',
  'spawn-timeout',
  'child-crashed',
  'unknown',
] as const;

export type OfficeSidecarErrorCode = (typeof OFFICE_SIDECAR_ERROR_CODES)[number];

export const OFFICE_SIDECAR_ERROR_MESSAGES: Record<OfficeSidecarErrorCode, string> = {
  'port-in-use': 'Port 52100 is already in use by another program.',
  'cert-failed': "Couldn't set up the local secure connection Office requires.",
  'wef-install-failed': "Couldn't register the Office add-in with the system.",
  'spawn-timeout': 'The Office connection took too long to start.',
  'child-crashed': 'The Office connection stopped unexpectedly.',
  unknown: "Couldn't start the Office connection.",
};

export function sanitizeOfficeSidecarError(code: OfficeSidecarErrorCode): string {
  return OFFICE_SIDECAR_ERROR_MESSAGES[code];
}
