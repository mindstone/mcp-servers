import { describe, expect, it } from 'vitest';
import { sanitizeEmail } from '../src/modules/accounts/manager.js';

describe('sanitizeEmail parity', () => {
  it('keeps existing filename shape for engineering@mindstone.com', () => {
    expect(sanitizeEmail('engineering@mindstone.com')).toBe('engineering-mindstone-com');
  });
});
