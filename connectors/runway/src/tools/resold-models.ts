import { RunwayError } from '../types.js';
import { IMAGE_TO_VIDEO, TEXT_TO_VIDEO, TEXT_TO_IMAGE, type ResoldFieldSpec } from './resold-specs.generated.js';

// Models Runway resells from other makers. Each one rejects request fields it
// does not list (the API's schemas set additionalProperties: false), so the
// connector sends a resold model only the fields its own spec allows, and
// refuses any other option with a plain message naming the model, before any
// upload or request. The fields and limits come from Runway's published API
// spec (resold-specs.generated.ts); the defaults and prices below are typed by
// hand from Runway's pricing guide (docs.dev.runwayml.com/guides/pricing).
// These models were added from the documentation and never called (FOX-12868),
// so a mistake here fails for that one model only.

export const RESOLD_VIDEO_MODELS = [
  'kling_4', 'kling_4_flash', 'seedance2_5', 'seedance2_5_flash', 'gemini_omni_flash_1.2', 'hailuo3', 'h3_max',
  'wan3', 'wan3_prime', 'grok_imagine_1_5', 'grok_imagine_1_5_lite', 'happyhorse_1_0',
] as const;
export type ResoldVideoModel = (typeof RESOLD_VIDEO_MODELS)[number];

export const RESOLD_IMAGE_MODELS = [
  'gemini_image3_pro', 'gpt_image_2_6_sunburst', 'gpt_image_2_6_flare', 'gemini_image3.1_flash', 'gemini_image3.1_flash_lite',
  'nano_banana_2.1', 'seedream5.5', 'minimax_h3_image', 'ideogram_4_5', 'grok_imagine_image_2', 'muse_image', 'bria_fibo_1_5',
] as const;
export type ResoldImageModel = (typeof RESOLD_IMAGE_MODELS)[number];

export function isResoldVideoModel(model: string): model is ResoldVideoModel {
  return (RESOLD_VIDEO_MODELS as readonly string[]).includes(model);
}

export function isResoldImageModel(model: string): model is ResoldImageModel {
  return (RESOLD_IMAGE_MODELS as readonly string[]).includes(model);
}

export function videoSpec(model: ResoldVideoModel, kind: 'image' | 'text'): ResoldFieldSpec {
  return (kind === 'image' ? IMAGE_TO_VIDEO : TEXT_TO_VIDEO)[model];
}

// ── Price tiers ────────────────────────────────────────────────────────
// Runway prices a ratio by the resolution it belongs to. A ratio named auto_<tier>
// is that tier; any other W:H is the tier nearest its pixel count (checked
// against every listed ratio in resold-models.test.ts), unless overridden.

const VIDEO_TIER_PIXELS: Record<string, number> = {
  '360p': 640 * 360, '480p': 854 * 480, '720p': 1280 * 720, '768p': 1366 * 768, '1080p': 1920 * 1080, '2k': 2560 * 1440, '4k': 3840 * 2160,
};
const IMAGE_TIER_PIXELS: Record<string, number> = {
  '512': 512 * 512, '1k': 1024 * 1024, '1.5k': 1536 * 1536, '2k': 2048 * 2048, '4k': 4096 * 4096,
};

export function tierOf(ratio: string, tiers: readonly string[], pixels: Record<string, number>, overrides: Record<string, string> = {}): string {
  if (overrides[ratio]) return overrides[ratio];
  if (tiers.length === 1) return tiers[0];
  const named = ratio.match(/^auto_(.+)$/)?.[1];
  if (named && tiers.includes(named)) return named;
  const [w, h] = ratio.split(':').map(Number);
  const distance = (tier: string) => Math.abs(Math.log((w * h) / pixels[tier]));
  return tiers.reduce((best, tier) => (distance(tier) < distance(best) ? tier : best));
}

// ── Video ──────────────────────────────────────────────────────────────

interface VideoPricing {
  /** Sent when the caller gives none, so the estimate matches what Runway bills. */
  image: { ratio?: string; resolution?: string };
  text: { ratio?: string; resolution?: string };
  /** Credits per second of output, by tier. */
  rates: Record<string, number>;
  minimum?: number;
  /** Credits for each input frame (first and last). */
  perFrame?: number;
  tierOverrides?: Record<string, string>;
  /** Ratios allowed from an image, where Runway's spec narrows its list in prose. */
  imageRatios?: readonly string[];
}

const WIDE = { image: { ratio: 'auto_720p' }, text: { ratio: '1280:720' } };

export const VIDEO_PRICING: Record<ResoldVideoModel, VideoPricing> = {
  // List price; Runway charges 20% less until 30 Nov 2026.
  kling_4: { ...WIDE, rates: { '720p': 15.7, '1080p': 23.5 } },
  kling_4_flash: { ...WIDE, rates: { '720p': 9.4 }, minimum: 29 },
  seedance2_5: { image: { ratio: '1280:720' }, text: { ratio: '1280:720' }, rates: { '480p': 20, '720p': 30, '1080p': 68, '4k': 110 }, minimum: 80 },
  seedance2_5_flash: { image: { ratio: '1280:720' }, text: { ratio: '1280:720' }, rates: { '480p': 13, '720p': 20 }, minimum: 52 },
  'gemini_omni_flash_1.2': { image: { ratio: '1280:720' }, text: { ratio: '1280:720' }, rates: { '360p': 2, '720p': 7, '1080p': 10, '4k': 21 }, minimum: 6, perFrame: 1 },
  hailuo3: { image: { ratio: 'adaptive', resolution: '768p' }, text: { ratio: '16:9', resolution: '768p' }, rates: { '768p': 10, '2k': 15 }, perFrame: 2 },
  h3_max: { image: { resolution: '768p' }, text: { resolution: '768p' }, rates: { '480p': 5, '768p': 8 } },
  // Runway: keyframe image-to-video requests must use an auto_ ratio, which follows the first frame.
  wan3: { ...WIDE, rates: { '480p': 5, '720p': 10, '1080p': 20 }, imageRatios: ['auto_480p', 'auto_720p', 'auto_1080p'] },
  wan3_prime: { ...WIDE, rates: { '480p': 6.8, '720p': 14, '1080p': 28 }, imageRatios: ['auto_480p', 'auto_720p', 'auto_1080p'] },
  grok_imagine_1_5: { image: { resolution: '720p' }, text: { ratio: '16:9', resolution: '720p' }, rates: { '480p': 10, '720p': 16, '1080p': 29 }, perFrame: 1 },
  // Runway lists 720:720 with the 720p sizes.
  grok_imagine_1_5_lite: { ...WIDE, rates: { '480p': 2, '720p': 3, '1080p': 14 }, perFrame: 1, tierOverrides: { '720:720': '720p' } },
  happyhorse_1_0: { image: { resolution: '720p' }, text: { ratio: '1280:720' }, rates: { '720p': 15, '1080p': 30 } },
};

const VIDEO_OPTIONS = { audio: 'audio', seed: 'seed', negative_prompt: 'negativePrompt', content_moderation: 'contentModeration' } as const;
type VideoOption = keyof typeof VIDEO_OPTIONS;

function refuse(message: string, hint: string): never {
  throw new RunwayError(message, 'INVALID_INPUT', hint);
}

function checkPrompt(model: string, spec: ResoldFieldSpec, prompt: string | undefined): void {
  if (prompt === undefined) {
    if (spec.promptRequired) refuse(`${model} needs a prompt here.`, 'Pass prompt_text describing the video or image.');
    return;
  }
  const max = spec.maxPrompt ?? Infinity;
  if (prompt.length < spec.minPrompt || prompt.length > max) {
    refuse(
      `Prompt is ${prompt.length} characters; ${model} takes ${spec.minPrompt} to ${max}.`,
      prompt.length > max ? `Shorten the prompt to ${max} characters or fewer.` : `Write a prompt of at least ${spec.minPrompt} characters.`,
    );
  }
}

function pick(model: string, name: 'ratio' | 'resolution', given: string | undefined, fallback: string | undefined, allowed: readonly string[]): string | undefined {
  if (allowed.length === 0) {
    if (given !== undefined) refuse(`${model} does not take a ${name} here.`, `Leave ${name} out when using ${model}.`);
    return undefined;
  }
  const value = given ?? fallback;
  if (value === undefined || !allowed.includes(value)) {
    refuse(`${model} does not support ${name} ${value} here.`, `Use one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function checkSeed(model: string, spec: ResoldFieldSpec, seed: unknown): void {
  const max = spec.seedMax ?? 4294967295;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > max) {
    refuse(`${model} takes a seed from 0 to ${max}; got ${seed}.`, `Pick a seed from 0 to ${max}, or leave it out.`);
  }
}

/**
 * Check a resold model's prompt, ratio, resolution, duration, frames and options,
 * and return the body fields to send (besides model, promptImage and promptText)
 * with the estimated credits. Throws INVALID_INPUT, naming the model, for
 * anything its spec does not allow, before any request is made.
 */
export function resoldVideoFields(
  model: ResoldVideoModel,
  kind: 'image' | 'text',
  args: {
    prompt_text?: string; ratio?: string; resolution?: string; duration?: number; last_frame_image?: string;
    audio?: boolean; seed?: number; negative_prompt?: string; content_moderation?: string;
  },
): { fields: Record<string, unknown>; duration: number; credits: number } {
  const spec = videoSpec(model, kind);
  const pricing = VIDEO_PRICING[model];
  const defaults = pricing[kind];
  checkPrompt(model, spec, args.prompt_text);
  if (kind === 'text' && args.ratio === 'adaptive') {
    refuse(`${model} takes ratio adaptive only from an image.`, `Pick a fixed ratio: ${spec.ratios.filter((r) => r !== 'adaptive').join(', ')}.`);
  }
  const ratio = pick(model, 'ratio', args.ratio, defaults.ratio, (kind === 'image' && pricing.imageRatios) || spec.ratios);
  const resolution = pick(model, 'resolution', args.resolution, defaults.resolution, spec.resolutions);
  const duration = args.duration ?? 5;
  const range = spec.duration ?? { min: 5, max: 5 };
  if (!Number.isInteger(duration) || duration < range.min || duration > range.max) {
    refuse(
      `${model} takes a whole number of seconds from ${range.min} to ${range.max}; got ${duration}.`,
      `Pick a duration from ${range.min} to ${range.max} seconds.`,
    );
  }
  if (args.last_frame_image !== undefined && !spec.lastFrame) {
    refuse(`${model} takes only a first frame, not a last frame.`, `Leave last_frame_image out when using ${model}.`);
  }
  const fields: Record<string, unknown> = { duration };
  if (ratio !== undefined) fields.ratio = ratio;
  if (resolution !== undefined) fields.resolution = resolution;
  for (const option of Object.keys(VIDEO_OPTIONS) as VideoOption[]) {
    const value = args[option];
    if (value === undefined || (option === 'content_moderation' && value === 'auto')) continue;
    const key = VIDEO_OPTIONS[option];
    if (!spec.fields.includes(key)) refuse(`${model} does not accept ${option}.`, `Leave ${option} out when using ${model}.`);
    if (option === 'seed') checkSeed(model, spec, value);
    fields[key] = option === 'content_moderation' ? { publicFigureThreshold: value } : value;
  }
  const tier = resolution ?? tierOf(ratio ?? '', Object.keys(pricing.rates), VIDEO_TIER_PIXELS, pricing.tierOverrides);
  const frames = kind === 'image' ? (args.last_frame_image !== undefined ? 2 : 1) : 0;
  const credits = Math.max(pricing.minimum ?? 0, Math.ceil(pricing.rates[tier] * duration + frames * (pricing.perFrame ?? 0)));
  return { fields, duration, credits };
}

// ── Images ─────────────────────────────────────────────────────────────

// GPT Image 2.6 at the default high quality, by tier and shape (Runway's
// pricing guide). Each tier lists its ten ratios in this shape order.
const GPT_IMAGE_2_6_SHAPES = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '5:4', '4:3', '3:2', '16:9'];
const GPT_IMAGE_2_6_HIGH: Array<Record<string, number>> = [
  { '1:1': 11, '5:4': 8, '4:3': 7, '3:2': 6, '16:9': 5, '21:9': 4 },
  { '1:1': 16, '5:4': 11, '4:3': 10, '3:2': 8, '16:9': 6, '21:9': 5 },
  { '1:1': 19, '5:4': 15, '4:3': 14, '3:2': 13, '16:9': 11, '21:9': 7 },
];

function gptImage26Credits(ratio: string, references: number): number {
  const index = TEXT_TO_IMAGE.gpt_image_2_6_flare.ratios.indexOf(ratio);
  // With ratio "auto", Runway charges 19 credits up front at high quality.
  const perImage = ratio === 'auto' || index < 0 ? 19 : GPT_IMAGE_2_6_HIGH[Math.floor(index / 10)][GPT_IMAGE_2_6_SHAPES[index % 10]];
  return perImage + references;
}

// MiniMax H3 Image at the default (not highspeed): credits by reference count (row) and 1K, 2K, 4K.
const MINIMAX_H3_IMAGE = [
  [3, 3, 7], [3, 3, 8], [4, 4, 8], [4, 5, 8], [5, 5, 9], [6, 6, 10], [6, 7, 11], [7, 8, 11], [8, 8, 12],
  [9, 9, 13], [9, 10, 14], [10, 11, 14], [11, 12, 15], [12, 12, 16], [12, 13, 17], [13, 14, 18], [14, 15, 18],
];

/** Credits per image by tier, from the ratio's pixel count. */
const byTier = (table: Record<string, number>) => (ratio: string) => table[tierOf(ratio, Object.keys(table), IMAGE_TIER_PIXELS)];

interface ImagePricing {
  defaultRatio: string;
  credits: (ratio: string, references: number) => number;
  /** Sizes Runway swaps for others when reference images are given (each listed size is used only in its own mode). */
  withReferences?: Record<string, string>;
}

export const IMAGE_PRICING: Record<ResoldImageModel, ImagePricing> = {
  gemini_image3_pro: { defaultRatio: '1344:768', credits: byTier({ '1k': 20, '2k': 20, '4k': 40 }) },
  // Runway lists both 2.6 variants with one description and one price table.
  gpt_image_2_6_sunburst: { defaultRatio: '1920:1088', credits: gptImage26Credits },
  gpt_image_2_6_flare: { defaultRatio: '1920:1088', credits: gptImage26Credits },
  'gemini_image3.1_flash': { defaultRatio: '1344:768', credits: byTier({ '512': 5, '1k': 7, '2k': 11, '4k': 16 }) },
  'gemini_image3.1_flash_lite': { defaultRatio: '1376:768', credits: () => 4 },
  'nano_banana_2.1': { defaultRatio: '1376:768', credits: byTier({ '1k': 4, '2k': 6, '4k': 12 }) },
  'seedream5.5': { defaultRatio: '1424:800', credits: (ratio, refs) => Math.ceil(byTier({ '1k': 2, '1.5k': 2, '2k': 4 })(ratio) + refs * 0.8) },
  minimax_h3_image: { defaultRatio: '1376:768', credits: (ratio, refs) => MINIMAX_H3_IMAGE[refs][['1k', '2k', '4k'].indexOf(tierOf(ratio, ['1k', '2k', '4k'], IMAGE_TIER_PIXELS))] },
  // Runway's default quality: medium with reference images, high without.
  ideogram_4_5: {
    defaultRatio: '1280:720',
    credits: (_ratio, refs) => (refs > 0 ? 8 : 25),
    withReferences: { '1280:720': '1024:576', '720:1280': '576:1024', '1440:720': '1408:704', '720:1440': '704:1408' },
  },
  // Default quality medium; 1 credit per reference image.
  grok_imagine_image_2: { defaultRatio: '1280:720', credits: (ratio, refs) => byTier({ '1k': 6, '2k': 8 })(ratio) + refs },
  muse_image: { defaultRatio: '2016:1152', credits: () => 1 },
  // 1MP and 4MP sizes.
  bria_fibo_1_5: { defaultRatio: '1024:576', credits: byTier({ '1k': 5, '2k': 10 }) },
};

const REFERENCE_TAG = /^[a-z][a-z0-9_]{2,15}$/;

/** Check a resold image model's prompt, ratio, references and options; throws INVALID_INPUT naming the model. */
export function resoldImageFields(
  model: ResoldImageModel,
  args: { prompt_text: string; ratio?: string; seed?: number; content_moderation?: string; references: ReadonlyArray<{ tag?: string }> },
): { ratio: string; fields: Record<string, unknown>; credits: number } {
  const spec = TEXT_TO_IMAGE[model];
  const pricing = IMAGE_PRICING[model];
  checkPrompt(model, spec, args.prompt_text);
  const max = spec.maxReferences ?? 0;
  if (args.references.length > max) {
    refuse(`${model} takes at most ${max} reference images; got ${args.references.length}.`, `Pass ${max} reference images or fewer.`);
  }
  const tags = args.references.flatMap((r) => (r.tag === undefined ? [] : [r.tag]));
  if (tags.length > 0 && !spec.referenceTags) {
    refuse(`${model} does not take reference tags.`, 'Leave the tags out and refer to reference images by order ("the first image").');
  }
  const badTag = tags.find((tag) => !REFERENCE_TAG.test(tag));
  if (badTag !== undefined) {
    refuse(`${model} does not accept the reference tag "${badTag}".`, 'A tag is 3-16 characters: a lowercase letter, then lowercase letters, digits or underscores.');
  }
  if (new Set(tags).size !== tags.length) {
    refuse(`${model} needs a different tag on each reference image.`, 'Give each reference image its own tag, or leave tags out.');
  }
  const swap = pricing.withReferences ?? {};
  const withRefs = args.references.length > 0;
  const allowed = spec.ratios.filter((r) => !(withRefs ? r in swap : Object.values(swap).includes(r)));
  const fallback = withRefs ? (swap[pricing.defaultRatio] ?? pricing.defaultRatio) : pricing.defaultRatio;
  const ratio = pick(model, 'ratio', args.ratio, fallback, allowed) as string;
  const fields: Record<string, unknown> = {};
  if (args.seed !== undefined) {
    if (!spec.fields.includes('seed')) refuse(`${model} does not accept seed.`, `Leave seed out when using ${model}.`);
    checkSeed(model, spec, args.seed);
    fields.seed = args.seed;
  }
  if (args.content_moderation !== undefined && args.content_moderation !== 'auto') {
    if (!spec.fields.includes('contentModeration')) refuse(`${model} does not accept content_moderation.`, `Leave content_moderation out when using ${model}.`);
    fields.contentModeration = { publicFigureThreshold: args.content_moderation };
  }
  return { ratio, fields, credits: pricing.credits(ratio, args.references.length) };
}
