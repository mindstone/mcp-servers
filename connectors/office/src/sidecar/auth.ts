import { randomBytes } from 'node:crypto';
export {
  SIDECAR_LAST_FAILURE_FILE_NAME,
  SIDECAR_STATE_FILE_NAME,
  atomicWriteFile,
  readLastFailureFile,
  resolveLastFailureFilePath,
  resolveStateFilePath,
  writeLastFailureFile,
  writeStateFile,
  type SidecarLastFailure,
  type SidecarState,
} from '../shared/sidecar/stateFile.js';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}
