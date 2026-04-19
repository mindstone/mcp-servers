import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recraftFetch } from '../client.js';
import { buildMultipartForm } from '../files.js';
import { isConfigured } from '../auth.js';
import { withErrorHandling } from '../utils.js';
import type { RecraftGenerationResponse, RecraftUserInfo } from '../types.js';

function noApiKeyError(): string {
  return JSON.stringify({
    ok: false,
    error: 'Recraft API key not configured',
    resolution: 'To use Recraft, you need to configure an API key first.',
    next_step: {
      action: 'Ask the user for their Recraft API key, then call configure_recraft_api_key',
      tool_to_call: 'configure_recraft_api_key',
      tool_parameters: { api_key: '<user_provided_key>' },
      get_key_from: 'https://app.recraft.ai/profile/api',
    },
  });
}

const modelEnum = z.enum([
  'recraftv4',
  'recraftv4_vector',
  'recraftv4_pro',
  'recraftv4_pro_vector',
  'recraftv3',
  'recraftv3_vector',
  'recraftv2',
  'recraftv2_vector',
]);

function formatGenerationResult(response: RecraftGenerationResponse) {
  return {
    ok: true,
    images: response.data ?? (response.image ? [response.image] : []),
    raw: response,
  };
}

export function registerGenerationTools(server: McpServer): void {
  server.registerTool(
    'recraft_get_me',
    {
      description: 'Get current Recraft account info including credits balance.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    withErrorHandling(async () => {
      if (!isConfigured()) return noApiKeyError();
      const response = await recraftFetch<RecraftUserInfo>('/users/me');
      return JSON.stringify({ ok: true, user: response });
    }),
  );

  server.registerTool(
    'recraft__generate_image',
    {
      description: 'Generate an image using Recraft from a text prompt.',
      inputSchema: z.object({
        prompt: z.string().min(1),
        size: z.string().optional(),
        style: z.string().optional(),
        styleID: z.string().optional(),
        model: modelEnum.optional(),
        numberOfImages: z.number().int().min(1).max(6).optional(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
        negativePrompt: z.string().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const response = await recraftFetch<RecraftGenerationResponse>('/images/generations', {
        method: 'POST',
        body: JSON.stringify({
          prompt: args.prompt,
          size: args.size,
          style: args.style,
          style_id: args.styleID,
          model: args.model,
          n: args.numberOfImages,
          response_format: args.responseFormat,
          negative_prompt: args.negativePrompt,
        }),
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );

  server.registerTool(
    'recraft__image_to_image',
    {
      description: 'Generate an image using Recraft from an input image and a text prompt.',
      inputSchema: z.object({
        imageURI: z.string(),
        prompt: z.string().min(1),
        strength: z.number().min(0).max(1),
        style: z.string().optional(),
        styleID: z.string().optional(),
        model: z.enum(['recraftv3', 'recraftv3_vector']).optional(),
        numberOfImages: z.number().int().min(1).max(6).optional(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
        negativePrompt: z.string().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        {
          prompt: args.prompt,
          strength: args.strength,
          style: args.style,
          style_id: args.styleID,
          model: args.model,
          n: args.numberOfImages,
          response_format: args.responseFormat,
          negative_prompt: args.negativePrompt,
        },
        [{ fieldName: 'image', input: args.imageURI }],
      );
      const response = await recraftFetch<RecraftGenerationResponse>('/images/imageToImage', {
        method: 'POST',
        body: form,
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );

  server.registerTool(
    'recraft__creative_upscale',
    {
      description: 'Creatively upscale an image using Recraft.',
      inputSchema: z.object({
        imageURI: z.string(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        { response_format: args.responseFormat },
        [{ fieldName: 'file', input: args.imageURI }],
      );
      const response = await recraftFetch<RecraftGenerationResponse>('/images/creativeUpscale', {
        method: 'POST',
        body: form,
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );

  server.registerTool(
    'recraft__replace_background',
    {
      description: 'Replace the detected background of an image using Recraft and a text prompt.',
      inputSchema: z.object({
        imageURI: z.string(),
        prompt: z.string().min(1),
        style: z.string().optional(),
        styleID: z.string().optional(),
        model: z.enum(['recraftv3', 'recraftv3_vector']).optional(),
        numberOfImages: z.number().int().min(1).max(6).optional(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
        negativePrompt: z.string().optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        {
          prompt: args.prompt,
          style: args.style,
          style_id: args.styleID,
          model: args.model,
          n: args.numberOfImages,
          response_format: args.responseFormat,
          negative_prompt: args.negativePrompt,
        },
        [{ fieldName: 'image', input: args.imageURI }],
      );
      const response = await recraftFetch<RecraftGenerationResponse>('/images/replaceBackground', {
        method: 'POST',
        body: form,
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );

  server.registerTool(
    'recraft_remove_background',
    {
      description: 'Remove the background from an image using Recraft.',
      inputSchema: z.object({
        imageURI: z.string(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        { response_format: args.responseFormat },
        [{ fieldName: 'file', input: args.imageURI }],
      );
      const response = await recraftFetch<RecraftGenerationResponse>('/images/removeBackground', {
        method: 'POST',
        body: form,
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );

  server.registerTool(
    'recraft_vectorize_image',
    {
      description: 'Convert a raster image to SVG using Recraft.',
      inputSchema: z.object({
        imageURI: z.string(),
        responseFormat: z.enum(['url', 'b64_json']).optional(),
      }),
      annotations: { readOnlyHint: false },
    },
    withErrorHandling(async (args) => {
      if (!isConfigured()) return noApiKeyError();
      const form = await buildMultipartForm(
        { response_format: args.responseFormat },
        [{ fieldName: 'file', input: args.imageURI }],
      );
      const response = await recraftFetch<RecraftGenerationResponse>('/images/vectorize', {
        method: 'POST',
        body: form,
      });
      return JSON.stringify(formatGenerationResult(response));
    }),
  );
}
