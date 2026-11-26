import { describe, it, expect, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createBodyCapturingHandlers } from './helpers/runway-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY } from './fixtures/runway-data.js';

// Models Runway resells (Kling 4.0, Seedance 2.5, Nano Banana Pro, GPT Image
// 2.6, ElevenLabs v4). Each is sent only the fields its documented schema
// takes, and a wrong option fails for that model alone, with no request.

describe('Resold models', () => {
  let testClient: McpTestClient;

  afterEach(async () => {
    if (testClient) await testClient.close();
    vi.unstubAllEnvs();
  });

  async function setup() {
    const capture = createBodyCapturingHandlers(MOCK_API_KEY);
    mswServer.use(...capture.handlers);
    const requests: string[] = [];
    mswServer.events.on('request:start', ({ request }) => { requests.push(request.url); });
    testClient = await createTestClient({ env: { RUNWAYML_API_SECRET: MOCK_API_KEY, MCP_HOST_BRIDGE_STATE: '' } });
    return { ...capture, requests };
  }

  function bodyFor(captured: Array<{ url: string; body: unknown }>, path: string): Record<string, unknown> {
    const found = captured.find(c => c.url.includes(path))?.body as Record<string, unknown> | undefined;
    expect(found).toBeDefined();
    return found as Record<string, unknown>;
  }

  afterEach(() => { mswServer.events.removeAllListeners('request:start'); });

  describe('video', () => {
    it('sends kling_4 text-to-video with only its own fields and its default ratio', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A paper boat drifting down a rainy street', model: 'kling_4', duration: 10,
      });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.text);
      expect(data.model).toBe('kling_4');
      expect(data.estimated_credits).toBe(157);
      expect(bodyFor(capturedBodies, '/text_to_video')).toEqual({
        model: 'kling_4', promptText: 'A paper boat drifting down a rainy street', ratio: '1280:720', duration: 10,
      });
    });

    it('accepts a long prompt for kling_4 that older models refuse', async () => {
      const { requests } = await setup();
      const long = 'a'.repeat(2000);
      const ok = await testClient.callTool('generate_video_from_text', { prompt_text: long, model: 'kling_4' });
      expect(ok.isError).toBeFalsy();
      const refused = await testClient.callTool('generate_video_from_text', { prompt_text: long, model: 'gen4.5' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('at most 1000');
      expect(requests.filter(u => u.includes('/text_to_video'))).toHaveLength(1);
    });

    it('sends kling_4 image-to-video at auto_720p by default, with first and last frames', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_video_from_image', {
        prompt_image: 'https://example.com/first.png', last_frame_image: 'https://example.com/last.png', model: 'kling_4',
      });
      expect(result.isError).toBeFalsy();
      const body = bodyFor(capturedBodies, '/image_to_video');
      expect(body.ratio).toBe('auto_720p');
      expect(body.duration).toBe(5);
      expect(body.promptImage).toEqual([
        { uri: 'https://example.com/first.png', position: 'first' },
        { uri: 'https://example.com/last.png', position: 'last' },
      ]);
      expect(Object.keys(body).sort()).toEqual(['duration', 'model', 'promptImage', 'ratio']);
    });

    it('sends seedance2_5 audio and seed, and prices by resolution with its minimum', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A lighthouse in a storm', model: 'seedance2_5', ratio: '3840:2160', duration: 4, audio: false, seed: 7,
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.text).estimated_credits).toBe(440);
      expect(bodyFor(capturedBodies, '/text_to_video')).toMatchObject({ model: 'seedance2_5', ratio: '3840:2160', duration: 4, audio: false, seed: 7 });

      const cheap = await testClient.callTool('generate_video_from_text', {
        prompt_text: 'A lighthouse', model: 'seedance2_5', ratio: '854:480', duration: 4,
      });
      expect(JSON.parse(cheap.text).estimated_credits).toBe(80);
    });

    it.each([
      ['generate_video_from_text', { prompt_text: 'x', model: 'kling_4', seed: 1 }, 'kling_4 does not accept seed'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'kling_4', audio: true }, 'kling_4 does not accept audio'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'kling_4', content_moderation: 'low' }, 'kling_4 does not accept content_moderation'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'seedance2_5', negative_prompt: 'rain' }, 'seedance2_5 does not accept negative_prompt'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'kling_4', duration: 40 }, 'from 3 to 30'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'seedance2_5', duration: 2 }, 'from 4 to 30'],
      ['generate_video_from_image', { prompt_image: 'https://example.com/a.png', model: 'kling_4', ratio: '1280:720' }, 'kling_4 does not support ratio 1280:720'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'gen4.5', ratio: '3840:2160' }, 'gen4.5 does not support ratio 3840:2160'],
      ['generate_video_from_image', { prompt_image: 'https://example.com/a.png', model: 'gen4_turbo', ratio: 'auto_720p' }, 'gen4_turbo does not support ratio auto_720p'],
      ['generate_video_from_image', { prompt_image: 'https://example.com/a.png', model: 'seedance2_5', prompt_text: 'a'.repeat(15001) }, 'seedance2_5 takes 1 to 15000'],
      ['generate_video_from_image', { prompt_image: 'https://example.com/a.png', model: 'kling_4', prompt_text: 'a'.repeat(26001) }, 'kling_4 takes 1 to 26000'],
      ['generate_video_from_text', { prompt_text: 'a'.repeat(26001), model: 'kling_4' }, 'at most 26000'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'seedance2_5', seed: -1 }, 'seedance2_5 takes a seed from 0 to 4294967295'],
      ['generate_video_from_text', { prompt_text: 'x', model: 'seedance2_5', seed: 4294967296 }, 'seedance2_5 takes a seed from 0 to 4294967295'],
    ])('%s refuses %o before any request', async (tool, args, message) => {
      const { requests } = await setup();
      const result = await testClient.callTool(tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(requests).toEqual([]);
    });

    it('takes a kling_4 prompt up to its documented 26000 characters', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_video_from_text', { prompt_text: 'a'.repeat(26000), model: 'kling_4' });
      expect(result.isError).toBeFalsy();
      expect(bodyFor(capturedBodies, '/text_to_video').promptText).toHaveLength(26000);
    });

    it('leaves the existing models sending what they always sent', async () => {
      const { capturedBodies } = await setup();
      await testClient.callTool('generate_video_from_text', { prompt_text: 'A beach', model: 'veo3.1', seed: 3, negative_prompt: 'people' });
      expect(bodyFor(capturedBodies, '/text_to_video')).toEqual({
        model: 'veo3.1', promptText: 'A beach', ratio: '1280:720', duration: 8, audio: true, negativePrompt: 'people', seed: 3,
      });
      await testClient.callTool('generate_video_from_image', { prompt_image: 'https://example.com/a.png' });
      expect(bodyFor(capturedBodies, '/image_to_video')).toEqual({
        model: 'gen4_turbo', promptImage: 'https://example.com/a.png', ratio: '1280:720', duration: 5,
      });
    });
  });

  describe('images', () => {
    it('sends gemini_image3_pro with its default ratio and prices a 4K image at 40 credits', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_image', { prompt_text: 'A fox in snow', model: 'gemini_image3_pro' });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.text).estimated_credits).toBe(20);
      expect(bodyFor(capturedBodies, '/text_to_image')).toEqual({ model: 'gemini_image3_pro', promptText: 'A fox in snow', ratio: '1344:768' });

      const big = await testClient.callTool('generate_image', { prompt_text: 'A fox', model: 'gemini_image3_pro', ratio: '4096:4096' });
      expect(JSON.parse(big.text).estimated_credits).toBe(40);
    });

    it('sends gpt_image_2_6_sunburst with reference images and prices it by size and shape', async () => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_image', {
        prompt_text: 'The cat in the first image on a sofa', model: 'gpt_image_2_6_sunburst', ratio: '2560:1440',
        reference_images: [{ uri: 'https://example.com/cat.jpg', tag: 'cat' }],
      });
      expect(result.isError).toBeFalsy();
      // 2K 16:9 at high quality is 6 credits, plus 1 for the reference image.
      expect(JSON.parse(result.text).estimated_credits).toBe(7);
      expect(bodyFor(capturedBodies, '/text_to_image')).toEqual({
        model: 'gpt_image_2_6_sunburst', promptText: 'The cat in the first image on a sofa', ratio: '2560:1440',
        referenceImages: [{ uri: 'https://example.com/cat.jpg', tag: 'cat' }],
      });
    });

    it.each([
      [undefined, 5], ['1920:1920', 11], ['2160:3840', 11], ['2880:2880', 19], ['auto', 19],
    ])('prices gpt_image_2_6_flare at ratio %s as %d credits', async (ratio, credits) => {
      const { capturedBodies } = await setup();
      const result = await testClient.callTool('generate_image', { prompt_text: 'A lighthouse', model: 'gpt_image_2_6_flare', ...(ratio ? { ratio } : {}) });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.text).estimated_credits).toBe(credits);
      expect(bodyFor(capturedBodies, '/text_to_image').ratio).toBe(ratio ?? '1920:1088');
    });

    it('takes up to 16 reference images for gpt_image_2_6_flare', async () => {
      const { capturedBodies } = await setup();
      const refs = Array.from({ length: 16 }, (_, i) => ({ uri: `https://example.com/${i}.jpg` }));
      const result = await testClient.callTool('generate_image', { prompt_text: 'A collage', model: 'gpt_image_2_6_flare', reference_images: refs });
      expect(result.isError).toBeFalsy();
      expect(bodyFor(capturedBodies, '/text_to_image').referenceImages).toHaveLength(16);
    });

    it.each([
      [{ model: 'gemini_image3_pro', seed: 1 }, 'gemini_image3_pro does not accept seed'],
      [{ model: 'gpt_image_2_6_flare', content_moderation: 'low' }, 'gpt_image_2_6_flare does not accept content_moderation'],
      [{ model: 'gpt_image_2_6_flare', ratio: '1920:1080' }, 'gpt_image_2_6_flare does not support ratio 1920:1080'],
      [{ model: 'gen4_image', ratio: '4096:4096' }, 'gen4_image does not support ratio 4096:4096'],
      [{ model: 'gen4_image', ratio: 'auto' }, 'gen4_image does not support ratio auto'],
      [{ model: 'gemini_image3_pro', ratio: 'auto' }, 'gemini_image3_pro does not support ratio auto'],
      [{ model: 'gemini_image3_pro', prompt_text: 'x' }, 'gemini_image3_pro takes 3 to 45000'],
      [{ model: 'gpt_image_2_6_flare', prompt_text: 'a'.repeat(32001) }, 'gpt_image_2_6_flare takes 1 to 32000'],
      [{ model: 'gemini_image3_pro', reference_images: [{ uri: 'https://example.com/a.jpg', tag: 'BAD-TAG' }] }, 'gemini_image3_pro does not accept the reference tag'],
      [{ model: 'gpt_image_2_6_flare', reference_images: [{ uri: 'https://example.com/a.jpg', tag: 'cat' }, { uri: 'https://example.com/b.jpg', tag: 'cat' }] }, 'a different tag on each reference image'],
      [{ model: 'gemini_image3_pro', reference_images: Array.from({ length: 15 }, (_, i) => ({ uri: `https://example.com/${i}.jpg` })) }, 'gemini_image3_pro takes at most 14 reference images'],
      [{ model: 'gen4_image', reference_images: Array.from({ length: 4 }, (_, i) => ({ uri: `https://example.com/${i}.jpg` })) }, 'gen4_image takes at most 3 reference images'],
    ])('refuses %o before any request', async (args, message) => {
      const { requests } = await setup();
      const result = await testClient.callTool('generate_image', { prompt_text: 'xyz', ...args });
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(requests).toEqual([]);
    });

    it('leaves gen4_image sending what it always sent', async () => {
      const { capturedBodies } = await setup();
      await testClient.callTool('generate_image', { prompt_text: 'A hill', seed: 4 });
      expect(bodyFor(capturedBodies, '/text_to_image')).toEqual({ model: 'gen4_image', promptText: 'A hill', ratio: '1920:1080', seed: 4 });
    });
  });

  describe('speech', () => {
    it('sends eleven_v4 with a custom voice and prices at 5 credits per 1000 characters', async () => {
      const { capturedBodies } = await setup();
      const voice = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
      const result = await testClient.callTool('generate_speech', { text: 'a'.repeat(2000), model: 'eleven_v4', voice });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.text).estimated_credits).toBe(10);
      expect(bodyFor(capturedBodies, '/text_to_speech')).toEqual({
        model: 'eleven_v4', promptText: 'a'.repeat(2000), voice: { type: 'custom', id: voice },
      });
    });

    it('refuses empty eleven_v4 text before any request', async () => {
      const { requests } = await setup();
      const result = await testClient.callTool('generate_speech', { text: '', model: 'eleven_v4' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('eleven_v4 needs some text to speak');
      expect(requests).toEqual([]);
    });

    it('refuses an eleven_v4 custom voice ID that is not a version-4 UUID, before any request', async () => {
      const { requests } = await setup();
      const result = await testClient.callTool('generate_speech', { text: 'Hello', model: 'eleven_v4', voice: '4f1c2d3e-5a6b-1c7d-8e9f-0a1b2c3d4e5f' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('eleven_v4 does not accept the custom voice ID');
      expect(requests).toEqual([]);
    });

    it('refuses eleven_v4 text over 2500 characters before any request', async () => {
      const { requests } = await setup();
      const result = await testClient.callTool('generate_speech', { text: 'a'.repeat(2501), model: 'eleven_v4' });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('eleven_v4 supports at most 2500');
      expect(requests).toEqual([]);
    });
  });
});
