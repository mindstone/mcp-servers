import { RunwayError } from '../types.js';

// Models Runway resells from other makers. Each one rejects request fields it
// does not list (the API's schemas set additionalProperties: false), so the
// connector sends a resold model only the fields its own spec allows, and
// refuses any other option with a plain message naming the model. Ratios,
// durations and prices are from Runway's API reference and pricing guide.

export const RESOLD_VIDEO_MODELS = ['kling_4', 'seedance2_5'] as const;
export type ResoldVideoModel = (typeof RESOLD_VIDEO_MODELS)[number];

type VideoOption = 'audio' | 'seed' | 'negative_prompt' | 'content_moderation';

interface VideoSpec {
  label: string;
  imageRatios: readonly string[];
  textRatios: readonly string[];
  defaultImageRatio: string;
  defaultTextRatio: string;
  minDuration: number;
  maxDuration: number;
  defaultDuration: number;
  options: readonly VideoOption[];
  maxPromptChars: number;
  creditsPerSecond: (ratio: string) => number;
  minimumCredits: number;
}

const KLING_4_1080P = new Set(['1920:1080', '1080:1920', '1440:1440', '2200:940', 'auto_1080p']);

const SEEDANCE_TIERS: Array<[number, readonly string[]]> = [
  [20, ['992:432', '854:480', '752:560', '640:640', '560:752', '480:854']],
  [30, ['1470:630', '1280:720', '1112:834', '960:960', '834:1112', '720:1280']],
  [68, ['2206:946', '1920:1080', '1664:1248', '1440:1440', '1248:1664', '1080:1920']],
  [110, ['3840:1646', '3840:2160', '3840:2880', '3840:3840', '2880:3840', '2160:3840']],
];
const SEEDANCE_RATIOS = SEEDANCE_TIERS.flatMap(([, ratios]) => ratios);

export const VIDEO_SPECS: Record<ResoldVideoModel, VideoSpec> = {
  kling_4: {
    label: 'Kling 4.0',
    imageRatios: ['auto_720p', 'auto_1080p'],
    textRatios: ['1280:720', '720:1280', '940:940', '1460:624', '1920:1080', '1080:1920', '1440:1440', '2200:940', 'auto_720p', 'auto_1080p'],
    defaultImageRatio: 'auto_720p',
    defaultTextRatio: '1280:720',
    minDuration: 3,
    maxDuration: 30,
    defaultDuration: 5,
    options: [],
    maxPromptChars: 26000,
    // List price; Runway charges 20% less until 30 Nov 2026.
    creditsPerSecond: (ratio) => (KLING_4_1080P.has(ratio) ? 23.5 : 15.7),
    minimumCredits: 0,
  },
  seedance2_5: {
    label: 'Seedance 2.5',
    imageRatios: SEEDANCE_RATIOS,
    textRatios: SEEDANCE_RATIOS,
    defaultImageRatio: '1280:720',
    defaultTextRatio: '1280:720',
    minDuration: 4,
    maxDuration: 30,
    defaultDuration: 5,
    options: ['audio', 'seed'],
    maxPromptChars: 15000,
    creditsPerSecond: (ratio) => SEEDANCE_TIERS.find(([, ratios]) => ratios.includes(ratio))?.[0] ?? 30,
    minimumCredits: 80,
  },
};

export function isResoldVideoModel(model: string): model is ResoldVideoModel {
  return (RESOLD_VIDEO_MODELS as readonly string[]).includes(model);
}

const SEED_MAX = 4294967295;

function checkPrompt(model: string, prompt: string | undefined, min: number, max: number): void {
  if (prompt === undefined) return;
  if (prompt.length < min || prompt.length > max) {
    throw new RunwayError(
      `Prompt is ${prompt.length} characters; ${model} takes ${min} to ${max}.`,
      'INVALID_INPUT',
      prompt.length > max ? `Shorten the prompt to ${max} characters or fewer.` : `Write a prompt of at least ${min} characters.`,
    );
  }
}

const OPTION_BODY_KEYS: Record<VideoOption, string> = {
  audio: 'audio',
  seed: 'seed',
  negative_prompt: 'negativePrompt',
  content_moderation: 'contentModeration',
};

/**
 * Check a resold model's prompt, ratio, duration and options, and return the body
 * fields to send. Throws INVALID_INPUT, naming the model, for anything its
 * spec does not allow, before any request is made.
 */
export function resoldVideoFields(
  model: ResoldVideoModel,
  kind: 'image' | 'text',
  args: { prompt_text?: string; ratio?: string; duration?: number; audio?: boolean; seed?: number; negative_prompt?: string; content_moderation?: string },
): { ratio: string; duration: number; extra: Record<string, unknown>; credits: number } {
  const spec = VIDEO_SPECS[model];
  checkPrompt(model, args.prompt_text, 1, spec.maxPromptChars);
  const ratios = kind === 'image' ? spec.imageRatios : spec.textRatios;
  const ratio = args.ratio ?? (kind === 'image' ? spec.defaultImageRatio : spec.defaultTextRatio);
  if (!ratios.includes(ratio)) {
    throw new RunwayError(
      `${model} does not support ratio ${ratio} here.`,
      'INVALID_INPUT',
      `Use one of: ${ratios.join(', ')}.`,
    );
  }
  const duration = args.duration ?? spec.defaultDuration;
  if (!Number.isInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    throw new RunwayError(
      `${model} takes a whole number of seconds from ${spec.minDuration} to ${spec.maxDuration}; got ${duration}.`,
      'INVALID_INPUT',
      `Pick a duration from ${spec.minDuration} to ${spec.maxDuration} seconds.`,
    );
  }
  const extra: Record<string, unknown> = {};
  for (const option of Object.keys(OPTION_BODY_KEYS) as VideoOption[]) {
    const value = args[option];
    if (value === undefined || (option === 'content_moderation' && value === 'auto')) continue;
    if (!spec.options.includes(option)) {
      throw new RunwayError(
        `${model} does not accept ${option}.`,
        'INVALID_INPUT',
        `Leave ${option} out when using ${model}.`,
      );
    }
    if (option === 'seed' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > SEED_MAX)) {
      throw new RunwayError(`${model} takes a seed from 0 to ${SEED_MAX}; got ${value}.`, 'INVALID_INPUT', `Pick a seed from 0 to ${SEED_MAX}, or leave it out.`);
    }
    extra[OPTION_BODY_KEYS[option]] = value;
  }
  const credits = Math.max(spec.minimumCredits, Math.ceil(spec.creditsPerSecond(ratio) * duration));
  return { ratio, duration, extra, credits };
}

// ── Images ─────────────────────────────────────────────────────────────

export const RESOLD_IMAGE_MODELS = ['gemini_image3_pro', 'gpt_image_2_6_sunburst', 'gpt_image_2_6_flare'] as const;
export type ResoldImageModel = (typeof RESOLD_IMAGE_MODELS)[number];

const GPT_IMAGE_2_6_RATIOS = [
  '2048:880', '1920:1088', '1920:1280', '1920:1440', '1920:1536', '1920:1920', '1536:1920', '1440:1920', '1280:1920', '1088:1920',
  '2912:1248', '2560:1440', '2560:1712', '2560:1920', '2560:2048', '2560:2560', '2048:2560', '1920:2560', '1712:2560', '1440:2560',
  '3840:1648', '3840:2160', '3504:2336', '3264:2448', '3200:2560', '2880:2880', '2560:3200', '2448:3264', '2336:3504', '2160:3840',
];

const GEMINI_IMAGE_3_PRO_RATIOS = [
  '1344:768', '768:1344', '1024:1024', '1184:864', '864:1184', '1536:672', '832:1248', '1248:832', '896:1152', '1152:896',
  '2048:2048', '1696:2528', '2528:1696', '1792:2400', '2400:1792', '1856:2304', '2304:1856', '1536:2752', '2752:1536', '3168:1344',
  '4096:4096', '3392:5056', '5056:3392', '3584:4800', '4800:3584', '3712:4608', '4608:3712', '3072:5504', '5504:3072', '6336:2688',
];

// GPT Image 2.6 at the default high quality, by tier and shape (Runway's
// pricing guide). Each tier above lists its ten ratios in this shape order.
const GPT_IMAGE_2_6_SHAPES = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '5:4', '4:3', '3:2', '16:9'];
const GPT_IMAGE_2_6_HIGH: Array<Record<string, number>> = [
  { '1:1': 11, '5:4': 8, '4:3': 7, '3:2': 6, '16:9': 5, '21:9': 4 },
  { '1:1': 16, '5:4': 11, '4:3': 10, '3:2': 8, '16:9': 6, '21:9': 5 },
  { '1:1': 19, '5:4': 15, '4:3': 14, '3:2': 13, '16:9': 11, '21:9': 7 },
];
// With ratio "auto", Runway charges 19 credits up front at high quality.
const GPT_IMAGE_2_6_AUTO_CREDITS = 19;

function gptImage26Credits(ratio: string): number {
  const index = GPT_IMAGE_2_6_RATIOS.indexOf(ratio);
  if (index < 0) return GPT_IMAGE_2_6_AUTO_CREDITS;
  return GPT_IMAGE_2_6_HIGH[Math.floor(index / 10)][GPT_IMAGE_2_6_SHAPES[index % 10]];
}

interface ImageSpec {
  ratios: readonly string[];
  defaultRatio: string;
  minPromptChars: number;
  maxPromptChars: number;
  maxReferences: number;
  credits: (ratio: string) => number;
}

const GPT_IMAGE_2_6_SPEC: ImageSpec = {
  ratios: [...GPT_IMAGE_2_6_RATIOS, 'auto'],
  defaultRatio: '1920:1088',
  minPromptChars: 1,
  maxPromptChars: 32000,
  maxReferences: 16,
  credits: gptImage26Credits,
};

export const IMAGE_SPECS: Record<ResoldImageModel, ImageSpec> = {
  gemini_image3_pro: {
    ratios: GEMINI_IMAGE_3_PRO_RATIOS,
    defaultRatio: '1344:768',
    minPromptChars: 3,
    maxPromptChars: 45000,
    maxReferences: 14,
    // 20 credits at 1K or 2K, 40 at 4K (the last ten ratios).
    credits: (ratio) => (GEMINI_IMAGE_3_PRO_RATIOS.indexOf(ratio) >= 20 ? 40 : 20),
  },
  // Runway lists both 2.6 variants with one description and one price table.
  gpt_image_2_6_sunburst: GPT_IMAGE_2_6_SPEC,
  gpt_image_2_6_flare: GPT_IMAGE_2_6_SPEC,
};

export function isResoldImageModel(model: string): model is ResoldImageModel {
  return (RESOLD_IMAGE_MODELS as readonly string[]).includes(model);
}

const REFERENCE_TAG = /^[a-z][a-z0-9_]{2,15}$/;

/** Check a resold image model's prompt, ratio, references and options; throws INVALID_INPUT naming the model. */
export function resoldImageFields(
  model: ResoldImageModel,
  args: { prompt_text: string; ratio?: string; seed?: number; content_moderation?: string; references: ReadonlyArray<{ tag?: string }> },
): { ratio: string; credits: number } {
  const spec = IMAGE_SPECS[model];
  checkPrompt(model, args.prompt_text, spec.minPromptChars, spec.maxPromptChars);
  if (args.references.length > spec.maxReferences) {
    throw new RunwayError(
      `${model} takes at most ${spec.maxReferences} reference images; got ${args.references.length}.`,
      'INVALID_INPUT',
      `Pass ${spec.maxReferences} reference images or fewer.`,
    );
  }
  const tags = args.references.flatMap((r) => (r.tag === undefined ? [] : [r.tag]));
  const badTag = tags.find((tag) => !REFERENCE_TAG.test(tag));
  if (badTag !== undefined) {
    throw new RunwayError(
      `${model} does not accept the reference tag "${badTag}".`,
      'INVALID_INPUT',
      'A tag is 3-16 characters: a lowercase letter, then lowercase letters, digits or underscores.',
    );
  }
  if (new Set(tags).size !== tags.length) {
    throw new RunwayError(`${model} needs a different tag on each reference image.`, 'INVALID_INPUT', 'Give each reference image its own tag, or leave tags out.');
  }
  const ratio = args.ratio ?? spec.defaultRatio;
  if (!spec.ratios.includes(ratio)) {
    throw new RunwayError(`${model} does not support ratio ${ratio}.`, 'INVALID_INPUT', `Use one of: ${spec.ratios.join(', ')}.`);
  }
  if (args.seed !== undefined) {
    throw new RunwayError(`${model} does not accept seed.`, 'INVALID_INPUT', `Leave seed out when using ${model}.`);
  }
  if (args.content_moderation !== undefined && args.content_moderation !== 'auto') {
    throw new RunwayError(`${model} does not accept content_moderation.`, 'INVALID_INPUT', `Leave content_moderation out when using ${model}.`);
  }
  return { ratio, credits: spec.credits(ratio) + (model.startsWith('gpt_image') ? args.references.length : 0) };
}
