import { describe, it, expect } from 'vitest';
import { getErrorResolution } from '../src/types.js';

describe('getErrorResolution', () => {
  it('returns upload-format guidance for unsupported_content_type', () => {
    const resolution = getErrorResolution(
      400,
      "unsupported_content_type 'application/octet-stream'",
    );
    expect(resolution).toContain("isn't supported");
    expect(resolution).toContain('mp3');
    expect(resolution).not.toContain('policy');
  });

  it('returns policy guidance for genuine content-policy signals', () => {
    expect(getErrorResolution(400, 'content policy violation')).toBe(
      'Content policy violation. Try a different prompt.',
    );
    expect(getErrorResolution(400, 'flagged by moderation')).toBe(
      'Content policy violation. Try a different prompt.',
    );
    expect(getErrorResolution(400, 'policy violation on input')).toBe(
      'Content policy violation. Try a different prompt.',
    );
  });

  it('does not mislabel unsupported_content_type as a policy violation', () => {
    const resolution = getErrorResolution(400, 'unsupported_content_type');
    expect(resolution).not.toContain('policy violation');
  });
});
