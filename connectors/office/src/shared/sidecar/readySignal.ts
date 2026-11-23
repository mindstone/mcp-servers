import { z } from 'zod';

export const WefInstallResultSchema = z.object({
  app: z.union([z.enum(['word', 'excel', 'powerpoint']), z.literal('all')]),
  path: z.string().optional(),
  status: z.enum(['installed', 'unchanged', 'skipped', 'failed']),
  error: z.string().optional(),
  step: z.enum(['read-source', 'read-target', 'create-folder', 'write-target']).optional(),
  code: z.string().optional(),
}).strict().refine(
  (result) => result.status === 'failed' || (result.step === undefined && result.code === undefined),
  { message: 'Operation metadata is only valid on failed installs' },
);

export const ReadySignalSchema = z.object({
  type: z.literal('ready'),
  pid: z.number().int().positive(),
  port: z.number().int().positive(),
  token: z.string().min(32),
  stateFilePath: z.string().min(1),
  wefInstallResults: z.array(WefInstallResultSchema).optional(),
}).strict();

export type WefInstallResult = z.infer<typeof WefInstallResultSchema>;
export type ReadySignal = z.infer<typeof ReadySignalSchema>;

// This signal travels only over the manager's Node IPC channel, never stdout.
export const SetupWaitSignalSchema = z.object({
  type: z.literal('office-setup-wait'),
}).strict();

export function isTargetAccessBlocked(result: WefInstallResult, platform: string): boolean {
  return platform === 'darwin' && result.status === 'failed' && result.code === 'EPERM'
    && (result.step === 'read-target' || result.step === 'create-folder' || result.step === 'write-target');
}
