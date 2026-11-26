import { describe, it, expect, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { mswServer } from './helpers/setup.js';
import { createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';
import {
  RESOLD_VIDEO_MODELS, RESOLD_IMAGE_MODELS, VIDEO_PRICING, IMAGE_PRICING, videoSpec, resoldVideoFields, resoldImageFields,
} from '../src/tools/resold-models.js';
import { TEXT_TO_IMAGE } from '../src/tools/resold-specs.generated.js';

// Every resold model was added from Runway's published API spec and pricing
// guide, never called (FOX-12868). These tests hold the hand-typed defaults and
// prices to the generated spec, so a typing slip shows here, and show that a
// wrong option fails for that one model while the others carry on.

const KINDS = ['image', 'text'] as const;
const prompt = (min: number) => 'a'.repeat(Math.max(min, 20));

describe('resold catalog', () => {
  describe('video defaults and prices', () => {
    it.each(RESOLD_VIDEO_MODELS.flatMap((model) => KINDS.map((kind) => [model, kind] as const)))('%s %s-to-video: the defaults are allowed and priced', (model, kind) => {
      const spec = videoSpec(model, kind);
      const defaults = VIDEO_PRICING[model][kind];
      // A default is given exactly when the model takes that field.
      expect(defaults.ratio !== undefined).toBe(spec.ratios.length > 0);
      expect(defaults.resolution !== undefined).toBe(spec.resolutions.length > 0);
      if (defaults.ratio) expect(spec.ratios).toContain(defaults.ratio);
      if (defaults.resolution) expect(spec.resolutions).toContain(defaults.resolution);
      expect(spec.duration!.min).toBeLessThanOrEqual(5);
      expect(spec.duration!.max).toBeGreaterThanOrEqual(5);
      const { fields, credits } = resoldVideoFields(model, kind, { prompt_text: prompt(spec.minPrompt) });
      expect(Object.keys(fields).every((key) => spec.fields.includes(key))).toBe(true);
      expect(Number.isFinite(credits) && credits > 0).toBe(true);
    });

    it.each(RESOLD_VIDEO_MODELS.flatMap((model) => KINDS.map((kind) => [model, kind] as const)))('%s %s-to-video: every listed ratio and resolution has a price', (model, kind) => {
      const spec = videoSpec(model, kind);
      const p = prompt(spec.minPrompt);
      const ratios = (kind === 'image' && VIDEO_PRICING[model].imageRatios) || spec.ratios;
      for (const ratio of ratios.filter((r) => !(kind === 'text' && r === 'adaptive'))) {
        expect(Number.isFinite(resoldVideoFields(model, kind, { prompt_text: p, ratio }).credits), ratio).toBe(true);
      }
      for (const resolution of spec.resolutions) {
        expect(Number.isFinite(resoldVideoFields(model, kind, { prompt_text: p, resolution }).credits), resolution).toBe(true);
      }
    });

    it.each([
      // [model, kind, args, credits]: Runway's pricing guide, credits per second × seconds, plus per-frame and minimum.
      ['kling_4', 'text', { duration: 10 }, 157],
      ['kling_4', 'image', { ratio: 'auto_1080p', duration: 10 }, 235],
      ['kling_4_flash', 'text', { duration: 3 }, 29],
      ['seedance2_5_flash', 'text', { ratio: '854:480', duration: 4 }, 52],
      ['gemini_omni_flash_1.2', 'image', { duration: 5 }, 36],
      ['hailuo3', 'image', { duration: 5 }, 52],
      ['hailuo3', 'text', { resolution: '2k', duration: 10 }, 150],
      ['h3_max', 'text', { resolution: '480p', duration: 5 }, 25],
      ['wan3', 'text', { duration: 5 }, 50],
      ['wan3_prime', 'image', { ratio: 'auto_480p', duration: 5 }, 34],
      ['grok_imagine_1_5', 'image', { resolution: '1080p', duration: 5 }, 146],
      ['grok_imagine_1_5_lite', 'text', { ratio: '720:720', duration: 5 }, 15],
      ['happyhorse_1_0', 'image', { resolution: '1080p', duration: 5 }, 150],
    ] as const)('%s %s-to-video %o costs %i credits', (model, kind, args, credits) => {
      expect(resoldVideoFields(model, kind, { prompt_text: 'A kite over a beach', ...args }).credits).toBe(credits);
    });

    it.each([
      ['h3_max', 'image', { ratio: '1280:720' }, 'h3_max does not take a ratio here'],
      ['kling_4', 'text', { resolution: '1080p' }, 'kling_4 does not take a resolution here'],
      ['hailuo3', 'text', { ratio: 'adaptive' }, 'hailuo3 takes ratio adaptive only from an image'],
      ['hailuo3', 'image', { resolution: '1080p' }, 'hailuo3 does not support resolution 1080p'],
      ['wan3', 'text', { seed: 1 }, 'wan3 does not accept seed'],
      ['grok_imagine_1_5', 'image', { last_frame_image: 'https://example.com/b.png' }, 'grok_imagine_1_5 takes only a first frame'],
      ['happyhorse_1_0', 'image', { duration: 2 }, 'from 3 to 15'],
    ] as const)('%s %s-to-video refuses %o', (model, kind, args, message) => {
      expect(() => resoldVideoFields(model, kind, { prompt_text: 'A kite over a beach', ...args })).toThrow(message);
    });

    it('takes only an auto_ ratio for Wan from an image, as Runway says keyframes need', () => {
      for (const model of ['wan3', 'wan3_prime'] as const) {
        expect(resoldVideoFields(model, 'image', { prompt_text: 'A kite' }).fields.ratio).toBe('auto_720p');
        expect(() => resoldVideoFields(model, 'image', { prompt_text: 'A kite', ratio: '1920:1080', last_frame_image: 'https://example.com/b.png' }))
          .toThrow(`${model} does not support ratio 1920:1080`);
        expect(resoldVideoFields(model, 'text', { prompt_text: 'A kite', ratio: '1920:1080' }).fields.ratio).toBe('1920:1080');
      }
    });

    it('asks for a prompt where the model needs one', () => {
      expect(() => resoldVideoFields('wan3', 'image', {})).toThrow('wan3 needs a prompt');
      expect(resoldVideoFields('kling_4', 'image', {}).fields).toEqual({ ratio: 'auto_720p', duration: 5 });
    });
  });

  describe('image defaults and prices', () => {
    it.each(RESOLD_IMAGE_MODELS)('%s: the default and every listed ratio are allowed and priced', (model) => {
      const spec = TEXT_TO_IMAGE[model];
      expect(spec.ratios).toContain(IMAGE_PRICING[model].defaultRatio);
      const swap = IMAGE_PRICING[model].withReferences ?? {};
      for (const ratio of spec.ratios) {
        const references = Object.values(swap).includes(ratio) ? [{}] : [];
        const { credits } = resoldImageFields(model, { prompt_text: prompt(spec.minPrompt), ratio, references });
        expect(Number.isInteger(credits) && credits > 0, ratio).toBe(true);
      }
    });

    it.each([
      ['gemini_image3.1_flash', '4096:4096', 0, 16],
      ['gemini_image3.1_flash', '512:512', 0, 5],
      ['nano_banana_2.1', '2048:2048', 0, 6],
      ['seedream5.5', '1424:800', 2, 4],
      ['minimax_h3_image', '1376:768', 16, 14],
      ['ideogram_4_5', '1280:720', 0, 25],
      ['ideogram_4_5', '1024:576', 1, 8],
      ['grok_imagine_image_2', '1280:720', 2, 8],
      ['muse_image', '2016:1152', 0, 1],
      ['bria_fibo_1_5', '1024:576', 0, 5],
    ] as const)('%s at %s with %i references costs %i credits', (model, ratio, refs, credits) => {
      expect(resoldImageFields(model, { prompt_text: 'A fox in snow', ratio, references: Array.from({ length: refs }, () => ({})) }).credits).toBe(credits);
    });

    it('takes a seed only where the model lists one', () => {
      expect(resoldImageFields('bria_fibo_1_5', { prompt_text: 'A fox', seed: 9, references: [] }).fields).toEqual({ seed: 9 });
      expect(() => resoldImageFields('bria_fibo_1_5', { prompt_text: 'A fox', seed: 2147483648, references: [] })).toThrow('from 0 to 2147483647');
      expect(() => resoldImageFields('muse_image', { prompt_text: 'A fox', seed: 9, references: [] })).toThrow('muse_image does not accept seed');
    });

    it('swaps Ideogram\'s widescreen sizes when reference images are given, as Runway documents', () => {
      expect(resoldImageFields('ideogram_4_5', { prompt_text: 'A fox', references: [{}] }).ratio).toBe('1024:576');
      expect(resoldImageFields('ideogram_4_5', { prompt_text: 'A fox', references: [] }).ratio).toBe('1280:720');
      expect(() => resoldImageFields('ideogram_4_5', { prompt_text: 'A fox', ratio: '1280:720', references: [{}] })).toThrow('ideogram_4_5 does not support ratio 1280:720');
      expect(() => resoldImageFields('ideogram_4_5', { prompt_text: 'A fox', ratio: '1024:576', references: [] })).toThrow('ideogram_4_5 does not support ratio 1024:576');
      expect(resoldImageFields('ideogram_4_5', { prompt_text: 'A fox', ratio: '1024:1024', references: [{}] }).ratio).toBe('1024:1024');
    });

    it('refuses reference tags on models that take none', () => {
      expect(() => resoldImageFields('seedream5.5', { prompt_text: 'A fox', references: [{ tag: 'fox' }] })).toThrow('seedream5.5 does not take reference tags');
      expect(() => resoldImageFields('bria_fibo_1_5', { prompt_text: 'A fox', references: [{}, {}] })).toThrow('bria_fibo_1_5 takes at most 1 reference images');
    });
  });

  describe('through the tools', () => {
    let testClient: McpTestClient;
    afterEach(async () => {
      if (testClient) await testClient.close();
      vi.unstubAllEnvs();
      mswServer.events.removeAllListeners('request:start');
    });

    async function setup() {
      const capture = createBodyCapturingHandlers(MOCK_API_KEY);
      mswServer.use(...capture.handlers);
      const requests: string[] = [];
      mswServer.events.on('request:start', ({ request }) => { requests.push(request.url); });
      testClient = await createTestClient({ env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' } });
      return { ...capture, requests };
    }

    it('fails a wrong option for that one model, with no request, while the others still work', async () => {
      const { capturedBodies, requests } = await setup();
      const wrong = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/a.png', prompt_text: 'A kite', model: 'h3_max', ratio: '1280:720',
      });
      expect(wrong.isError).toBe(true);
      expect(wrong.text).toContain('h3_max does not take a ratio here');
      expect(requests).toEqual([]);

      const right = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/a.png', prompt_text: 'A kite', model: 'h3_max',
      });
      expect(right.isError).toBeFalsy();
      expect(capturedBodies.at(-1)?.body).toEqual({
        model: 'h3_max', promptImage: 'https://example.com/a.png', promptText: 'A kite', resolution: '768p', duration: 5,
      });

      const other = await testClient.callTool('generate_video_from_text', { prompt_text: 'A kite', model: 'wan3', audio: true });
      expect(other.isError).toBeFalsy();
      expect(capturedBodies.at(-1)?.body).toEqual({ model: 'wan3', promptText: 'A kite', ratio: '1280:720', duration: 5, audio: true });
      expect(JSON.parse(other.text).estimated_credits).toBe(50);
    });

    it('shows Runway\'s refusal of one model plainly, without retrying, while the others still work', async () => {
      const { capturedBodies } = await setup();
      let refused = 0;
      mswServer.use(http.post('https://api.dev.runwayml.com/v1/image_to_video', async ({ request }) => {
        const body = await request.clone().json() as { model?: string };
        if (body.model !== 'happyhorse_1_0') return undefined;
        refused++;
        return HttpResponse.json({ error: 'Validation of body failed' }, { status: 400 });
      }));
      const wrong = await testClient.callTool('generate_video_from_image', { prompt_image: 'https://example.com/a.png', prompt_text: 'A kite', model: 'happyhorse_1_0' });
      expect(wrong.isError).toBe(true);
      expect(wrong.text).toContain('HTTP 400');
      expect(wrong.text).toContain('Validation of body failed');
      expect(refused).toBe(1);

      for (const model of ['kling_4', 'gen4_turbo'] as const) {
        const ok = await testClient.callTool('generate_video_from_image', { prompt_image: 'https://example.com/a.png', prompt_text: 'A kite', model });
        expect(ok.isError, model).toBeFalsy();
        expect((capturedBodies.at(-1)?.body as { model: string }).model).toBe(model);
      }
    });

    it('sends a resold image model only its own fields', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_image', { prompt_text: 'A fox in snow', model: 'bria_fibo_1_5', seed: 4 });
      expect(result.isError).toBeFalsy();
      expect(capturedBodies.at(-1)?.body).toEqual({ model: 'bria_fibo_1_5', promptText: 'A fox in snow', ratio: '1024:576', seed: 4 });
      expect(JSON.parse(result.text).estimated_credits).toBe(5);
    });

    it('refuses a resolution on Runway\'s own models', async () => {
      const { requests } = await setup();
      const result = await testClient.callTool('generate_video_from_text', { prompt_text: 'A kite', model: 'gen4.5', resolution: '1080p' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('gen4.5 does not take a resolution');
      expect(requests).toEqual([]);
    });
  });
});
