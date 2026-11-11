import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  SUPPORTED_MODELS,
  isSupportedModel,
  modelKnownToRejectTransparency,
  modelSupportsModeration,
} from '../src/models.js';

describe('model list', () => {
  it('defaults to a supported model', () => {
    expect(DEFAULT_MODEL).toBe('gpt-image-2.6-sunburst');
    expect(isSupportedModel(DEFAULT_MODEL)).toBe(true);
  });

  it('lists both gpt-image-2.5 models and drops the gpt-image-1 generation', () => {
    expect(SUPPORTED_MODELS).toContain('gpt-image-2.5-flare');
    expect(SUPPORTED_MODELS).toContain('gpt-image-2.5-sunburst');
    expect(isSupportedModel('gpt-image-1')).toBe(false);
    expect(isSupportedModel('gpt-image-1.5')).toBe(false);
    expect(isSupportedModel('gpt-image-1-mini')).toBe(false);
  });

  it('recognizes both gpt-image-2.6 variants', () => {
    expect(SUPPORTED_MODELS).toContain('gpt-image-2.6-sunburst');
    expect(SUPPORTED_MODELS).toContain('gpt-image-2.6-flare');
    expect(isSupportedModel('gpt-image-2.6-sunburst')).toBe(true);
    expect(isSupportedModel('gpt-image-2.6-flare')).toBe(true);
  });

  it('treats only gpt-image-2 and its snapshots as refusing transparency', () => {
    expect(modelKnownToRejectTransparency('gpt-image-2')).toBe(true);
    expect(modelKnownToRejectTransparency('gpt-image-2-2026-04-21')).toBe(true);
    expect(modelKnownToRejectTransparency('gpt-image-2.5-sunburst')).toBe(false);
    expect(modelKnownToRejectTransparency('gpt-image-2.5-flare-2026-09-08')).toBe(false);
    expect(modelKnownToRejectTransparency('gpt-image-2.6-sunburst')).toBe(false);
    expect(modelKnownToRejectTransparency('gpt-image-2.6-flare')).toBe(false);
    expect(modelKnownToRejectTransparency('gpt-image-1.5')).toBe(false);
  });

  it('sends moderation to the whole gpt-image-2 family, 2.5 included', () => {
    expect(modelSupportsModeration('gpt-image-2')).toBe(true);
    expect(modelSupportsModeration('gpt-image-2.5-flare')).toBe(true);
    expect(modelSupportsModeration('gpt-image-2.6-sunburst')).toBe(true);
    expect(modelSupportsModeration('gpt-image-2.6-flare')).toBe(true);
    expect(modelSupportsModeration('gpt-image-1.5')).toBe(false);
  });
});
