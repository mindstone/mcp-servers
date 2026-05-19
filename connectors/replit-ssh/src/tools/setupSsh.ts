import { z } from 'zod';

import { runSetupSsh } from '../setup.js';

export const setupSshSchema = z.object({
  force_regenerate: z
    .boolean()
    .optional()
    .describe('Generate a new key even if one exists (default: false)'),
});

export type SetupSshArgs = z.infer<typeof setupSshSchema>;

export async function replitSetupSsh(args: SetupSshArgs): Promise<string> {
  const forceRegenerate = args.force_regenerate === true;
  return runSetupSsh(forceRegenerate);
}
