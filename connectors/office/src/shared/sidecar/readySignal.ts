import { z } from 'zod';

export const WefInstallResultSchema = z.object({
  app: z.union([z.enum(['word', 'excel', 'powerpoint']), z.literal('all')]),
  path: z.string().optional(),
  status: z.enum(['installed', 'unchanged', 'skipped', 'failed']),
  error: z.string().optional(),
}).strict();

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
