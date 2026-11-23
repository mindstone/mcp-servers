export const OFFICE_SIDECAR_ERROR_CODES = [
  'port-in-use',
  'cert-failed',
  'wef-install-failed',
  'office-access-blocked',
  'office-setup-timeout',
  'spawn-timeout',
  'child-crashed',
  'unknown',
] as const;

export type OfficeSidecarErrorCode = (typeof OFFICE_SIDECAR_ERROR_CODES)[number];

export const OFFICE_SIDECAR_ERROR_MESSAGES: Record<OfficeSidecarErrorCode, string> = {
  'port-in-use': 'Port 52100 is already in use by another program.',
  'cert-failed': "Couldn't set up the local secure connection Office requires.",
  'wef-install-failed': "Couldn't register the Office add-in with the system.",
  'office-access-blocked': "Your computer blocked Rebel's setup in Word, Excel and PowerPoint. This setup lets Rebel work with your documents. If it asked whether Mindstone Rebel can access data from other apps and you chose Don't Allow, quit and reopen Rebel, then choose Allow if it asks again.",
  'office-setup-timeout': "Adding Rebel so it can work with your Word, Excel and PowerPoint documents didn't finish in time. If your computer is still asking whether Mindstone Rebel can access data from other apps, answer it, then try again. If Try again is missing, turn on or connect Microsoft Office in Rebel's settings, then wait for the connection status to update.",
  'spawn-timeout': 'The Office connection took too long to start.',
  'child-crashed': 'The Office connection stopped unexpectedly.',
  unknown: "Couldn't start the Office connection.",
};

export function sanitizeOfficeSidecarError(code: OfficeSidecarErrorCode): string {
  return OFFICE_SIDECAR_ERROR_MESSAGES[code];
}

export function isOfficeInstallFailureCode(code: string | undefined): boolean {
  return code === 'wef-install-failed' || code === 'office-access-blocked' || code === 'office-setup-timeout';
}
