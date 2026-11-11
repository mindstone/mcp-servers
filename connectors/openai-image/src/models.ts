// The OpenAI image models this connector knows, newest first. Exported on its
// own so other tools can read the list without loading the server.
// gpt-image-2 stays for its transparency gate below; older models are left out.
export const SUPPORTED_MODELS = [
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'gpt-image-2',
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = 'gpt-image-2.6-sunburst';

export const isSupportedModel = (model: string): model is SupportedModel =>
  (SUPPORTED_MODELS as readonly string[]).includes(model);

// gpt-image-2 and its dated snapshots (gpt-image-2-YYYY-MM-DD) reject
// background: 'transparent' upstream (verified 2026-11). A plain
// startsWith('gpt-image-2') would also catch gpt-image-2.5-*, which accepts it.
export const modelKnownToRejectTransparency = (model: string): boolean =>
  model === 'gpt-image-2' || model.startsWith('gpt-image-2-');

// The gpt-image-2 family, 2.5 included, accepts the `moderation` parameter.
export const modelSupportsModeration = (model: string): boolean =>
  model.startsWith('gpt-image-2');
