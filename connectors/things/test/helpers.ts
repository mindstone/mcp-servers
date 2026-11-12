import { unwrapUntrusted } from '../src/untrusted-content.js';

/** A tool result's text, split into its plain metadata line and its (unwrapped) data. */
export function parse(text: string): { meta: Record<string, unknown>; data: any } {
  const nl = text.indexOf('\n');
  if (nl < 0) throw new Error(`Not a data result: ${text}`);
  const body = text.slice(nl + 1);
  if (!body.startsWith('<untrusted-content source="things">')) throw new Error('Data is not enveloped');
  return { meta: JSON.parse(text.slice(0, nl)), data: JSON.parse(unwrapUntrusted(body)) };
}
