import { timingSafeEqual } from 'node:crypto';

export function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
