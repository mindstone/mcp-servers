import { z } from 'zod';
import { isAbsolute } from 'node:path';

/** Negotiation is connection-scoped; the selected mode belongs to one SDK request. */
export const FILE_READ_CAPABILITIES = { experimental: { 'files/readModes': { version: 1 } } };
const locationSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
const allowedReadSchema = z.object({
  location: locationSchema, rawPath: z.string(), canonicalPath: z.string().refine(isAbsolute),
}).strict();
export const readModeSchema = z.discriminatedUnion('mode', [
  z.object({ version: z.literal(1), mode: z.literal('central'), reads: z.array(allowedReadSchema) }).strict(),
  z.object({ version: z.literal(1), mode: z.literal('standalone') }).strict(),
]);
export type FileReadContext = z.infer<typeof readModeSchema>;
const capabilitiesSchema = z.object({ experimental: z.object({
  'files/readModes': z.object({ version: z.literal(1) }).passthrough(),
}).passthrough() }).passthrough();
const extraSchema = z.object({ _meta: z.object({ 'files/readMode': readModeSchema }).passthrough() }).passthrough();

/** Pass SDK extra here, never model arguments or arguments._meta. */
export function fileReadContext(capabilities: unknown, extra: unknown): FileReadContext {
  if (!capabilitiesSchema.safeParse(capabilities).success) return { version: 1, mode: 'standalone' };
  const parsed = extraSchema.safeParse(extra);
  if (!parsed.success) throw new Error('Negotiated file reads require valid request files/readMode metadata.');
  return parsed.data._meta['files/readMode'];
}

/** Exact concrete operand lookup only; canonicalization and permission belong to the host. */
export function centralReadPath(context: FileReadContext | undefined, rawPath: string, location: (string | number)[]): string | undefined {
  if (!context || context.mode === 'standalone') return undefined;
  const matches = context.reads.filter(read => read.rawPath === rawPath &&
    read.location.length === location.length && read.location.every((part, index) => part === location[index]));
  if (matches.length !== 1) throw new Error('Central file read requires exactly one allowed concrete operand.');
  return matches[0].canonicalPath;
}
