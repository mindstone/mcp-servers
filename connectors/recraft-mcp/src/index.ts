#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

const RECRAFT_API_BASE_URL = process.env.RECRAFT_API_BASE_URL || "https://external.api.recraft.ai/v1";
const RECRAFT_API_KEY = process.env.RECRAFT_API_KEY;
const GENERATED_OUTPUT_DIR = process.env.RECRAFT_OUTPUT_DIR || "/Users/melissanthipapacharalampous/Documents/Mindstone Rebel/Chief-of-Staff/generated-images/recraft";
const MAX_JSON_TEXT = 20000;
const REQUEST_TIMEOUT_MS = 60000;

const ALLOWED_STYLE_BASES = ["any", "realistic_image", "digital_illustration", "vector_illustration", "icon"] as const;
const RESPONSE_FORMATS = ["url", "b64_json"] as const;
const IMAGE_FORMATS = ["png", "webp"] as const;
const GENERATION_MODELS = ["recraftv4", "recraftv4_vector", "recraftv4_pro", "recraftv4_pro_vector", "recraftv3", "recraftv3_vector", "recraftv2", "recraftv2_vector"] as const;
const V3_MODELS = ["recraftv3", "recraftv3_vector"] as const;
const EXPLORE_MODELS = ["recraftv4", "recraftv4_vector", "recraftv4_pro", "recraftv4_pro_vector"] as const;

const server = new McpServer({
  name: "recraft-mcp",
  version: "1.0.0",
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ApiCallResult = {
  ok: boolean;
  status: number | null;
  data?: unknown;
  error?: string;
};

function missingConfigError(varName: string): string {
  return `${varName} is not configured. Set it in your .env file or your MCP host's connector environment variables, then retry.`;
}

function ensureHttps(urlString: string): void {
  const url = new URL(urlString);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("RECRAFT_API_BASE_URL must use HTTPS unless it targets localhost.");
  }
}

function truncate(text: string, max = MAX_JSON_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compactJson(value: unknown): string {
  return truncate(JSON.stringify(value, null, 2));
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "asset";
}

function mimeToExtension(contentType: string | null, fallback = ".bin"): string {
  if (!contentType) return fallback;
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("json")) return ".json";
  return fallback;
}

async function ensureOutputDir(): Promise<void> {
  await mkdir(GENERATED_OUTPUT_DIR, { recursive: true });
}

async function saveBufferAsset(kind: string, buffer: Buffer, extension: string): Promise<string> {
  await ensureOutputDir();
  const filePath = join(GENERATED_OUTPUT_DIR, `${normalizeLabel(kind)}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`);
  await writeFile(filePath, buffer);
  return filePath;
}

async function downloadToFile(urlString: string, kind: string): Promise<{ local_path: string; remote_url: string }> {
  const response = await fetch(urlString);
  if (!response.ok) {
    throw new Error(`Failed to download generated asset (${response.status}) from ${urlString}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const extension = extname(new URL(urlString).pathname) || mimeToExtension(response.headers.get("content-type"), ".bin");
  const localPath = await saveBufferAsset(kind, Buffer.from(arrayBuffer), extension);
  return { local_path: localPath, remote_url: urlString };
}

async function saveBase64Asset(base64Value: string, kind: string, extension = ".png"): Promise<string> {
  const buffer = Buffer.from(base64Value, "base64");
  return saveBufferAsset(kind, buffer, extension);
}

async function readLocalFile(filePath: string): Promise<{ filename: string; blob: Blob }> {
  const resolved = resolve(filePath);
  const data = await readFile(resolved);
  const extension = extname(resolved).toLowerCase();
  const mimeType = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : extension === ".svg" ? "image/svg+xml" : "application/octet-stream";
  return {
    filename: basename(resolved),
    blob: new Blob([data], { type: mimeType }),
  };
}

async function apiJsonRequest(endpoint: string, method: string, body?: JsonValue): Promise<ApiCallResult> {
  if (!RECRAFT_API_KEY) {
    return { ok: false, status: null, error: missingConfigError("RECRAFT_API_KEY") };
  }

  ensureHttps(RECRAFT_API_BASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(new URL(endpoint, `${RECRAFT_API_BASE_URL}/`).toString(), {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${RECRAFT_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    clearTimeout(timeout);

    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: `Recraft API error ${response.status}: ${truncate(typeof parsed === "string" ? parsed : JSON.stringify(parsed))}` };
    }

    return { ok: true, status: response.status, data: parsed };
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, error: `Request failed: ${message}` };
  }
}

async function apiFormRequest(endpoint: string, form: FormData): Promise<ApiCallResult> {
  if (!RECRAFT_API_KEY) {
    return { ok: false, status: null, error: missingConfigError("RECRAFT_API_KEY") };
  }

  ensureHttps(RECRAFT_API_BASE_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(new URL(endpoint, `${RECRAFT_API_BASE_URL}/`).toString(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${RECRAFT_API_KEY}`,
      },
      body: form,
    });

    const contentType = response.headers.get("content-type") || "";
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return { ok: false, status: response.status, error: `Recraft API error ${response.status}: ${truncate(errorText)}` };
    }

    if (contentType.includes("application/json")) {
      return { ok: true, status: response.status, data: await response.json() };
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      ok: true,
      status: response.status,
      data: {
        binary: Buffer.from(arrayBuffer).toString("base64"),
        content_type: contentType,
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: null, error: `Request failed: ${message}` };
  }
}

function toolError(message: string, status?: number | null) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: status ? `${message}\nHTTP status: ${status}` : message }],
  };
}

async function collectGenerationAssets(payload: unknown, kind: string): Promise<Array<{ local_path: string; remote_url?: string; b64_json?: string }>> {
  const assets: Array<{ local_path: string; remote_url?: string; b64_json?: string }> = [];
  const dataArray = Array.isArray((payload as { data?: unknown[] })?.data) ? (payload as { data: Array<{ url?: string; b64_json?: string }> }).data : [];

  for (const [index, item] of dataArray.entries()) {
    if (item.url) {
      assets.push(await downloadToFile(item.url, `${kind}-${index + 1}`));
    } else if (item.b64_json) {
      const localPath = await saveBase64Asset(item.b64_json, `${kind}-${index + 1}`);
      assets.push({ local_path: localPath, b64_json: item.b64_json });
    }
  }

  return assets;
}

async function collectSingleImageAsset(payload: unknown, kind: string): Promise<{ local_path: string; remote_url?: string; b64_json?: string } | null> {
  const image = (payload as { image?: { url?: string; b64_json?: string } })?.image;
  if (!image) return null;
  if (image.url) return downloadToFile(image.url, kind);
  if (image.b64_json) {
    const localPath = await saveBase64Asset(image.b64_json, kind);
    return { local_path: localPath, b64_json: image.b64_json };
  }
  return null;
}

const controlsSchema = z.record(z.string(), z.unknown()).optional().describe("Optional Recraft controls object copied through to the API.");
const textLayoutSchema = z.array(z.object({
  text: z.string(),
  bbox: z.array(z.tuple([z.number(), z.number()])).length(4),
})).optional().describe("Optional Recraft text layout array for supported V3 models.");

server.registerTool(
  "recraft_get_user_info",
  {
    title: "Recraft user info",
    description: "Return the current Recraft user profile and credits balance.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    const result = await apiJsonRequest("users/me", "GET");
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    return { content: [{ type: "text", text: compactJson(result.data) }] };
  }
);

server.registerTool(
  "recraft_generate_image",
  {
    title: "Generate image",
    description: "Generate one or more images from a prompt with Recraft and save them locally.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000),
      n: z.number().int().min(1).max(6).optional(),
      model: z.enum(GENERATION_MODELS).optional(),
      style: z.string().optional(),
      style_id: z.string().uuid().optional(),
      size: z.string().optional(),
      negative_prompt: z.string().optional(),
      response_format: z.enum(RESPONSE_FORMATS).optional(),
      controls: controlsSchema,
      text_layout: textLayoutSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const result = await apiJsonRequest("images/generations", "POST", params as unknown as JsonValue);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    const saved_assets = await collectGenerationAssets(result.data, "generate-image");
    return { content: [{ type: "text", text: compactJson({ saved_assets, response: result.data }) }] };
  }
);

server.registerTool(
  "recraft_create_style",
  {
    title: "Create style",
    description: "Upload up to five reference images and create a reusable Recraft style.",
    inputSchema: z.object({
      style: z.enum(ALLOWED_STYLE_BASES),
      image_paths: z.array(z.string().min(1)).min(1).max(5),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const form = new FormData();
    form.set("style", params.style);
    for (const [index, filePath] of params.image_paths.entries()) {
      const file = await readLocalFile(filePath);
      form.append(`file${index + 1}`, file.blob, file.filename);
    }
    const result = await apiFormRequest("styles", form);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    return { content: [{ type: "text", text: compactJson(result.data) }] };
  }
);

function registerImagePlusPromptTool(name: string, title: string, description: string, endpoint: string, withMask = false) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: z.object({
        image_path: z.string().min(1),
        ...(withMask ? { mask_path: z.string().min(1) } : {}),
        prompt: z.string().min(1).max(4000),
        n: z.number().int().min(1).max(6).optional(),
        model: z.enum(V3_MODELS).optional(),
        style: z.string().optional(),
        style_id: z.string().uuid().optional(),
        response_format: z.enum(RESPONSE_FORMATS).optional(),
        negative_prompt: z.string().optional(),
        controls: controlsSchema,
        text_layout: textLayoutSchema,
        strength: name === "recraft_image_to_image" ? z.number().min(0).max(1) : z.number().min(0).max(1).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const form = new FormData();
      const image = await readLocalFile(params.image_path);
      form.append("image", image.blob, image.filename);
      if (withMask && typeof params.mask_path === "string") {
        const mask = await readLocalFile(params.mask_path);
        form.append("mask", mask.blob, mask.filename);
      }
      for (const [key, value] of Object.entries(params)) {
        if (key === "image_path" || key === "mask_path") continue;
        if (value === undefined) continue;
        form.append(key, typeof value === "string" ? value : String(value));
      }
      const result = await apiFormRequest(endpoint, form);
      if (!result.ok) return toolError(result.error || "Unknown error", result.status);
      const saved_assets = await collectGenerationAssets(result.data, name);
      return { content: [{ type: "text", text: compactJson({ saved_assets, response: result.data }) }] };
    }
  );
}

registerImagePlusPromptTool("recraft_image_to_image", "Image to image", "Create prompt-guided variations of an input image.", "images/imageToImage");
registerImagePlusPromptTool("recraft_inpaint_image", "Inpaint image", "Regenerate masked regions of an image.", "images/inpaint", true);
registerImagePlusPromptTool("recraft_replace_background", "Replace background", "Replace the detected background of an image based on a prompt.", "images/replaceBackground");
registerImagePlusPromptTool("recraft_generate_background", "Generate background", "Generate new background content inside masked regions.", "images/generateBackground", true);

function registerSingleFileTool(name: string, title: string, description: string, endpoint: string) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: z.object({
        image_path: z.string().min(1),
        response_format: z.enum(RESPONSE_FORMATS).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const form = new FormData();
      const file = await readLocalFile(params.image_path);
      form.append("file", file.blob, file.filename);
      if (params.response_format) form.append("response_format", params.response_format);
      const result = await apiFormRequest(endpoint, form);
      if (!result.ok) return toolError(result.error || "Unknown error", result.status);
      const asset = await collectSingleImageAsset(result.data, name);
      return { content: [{ type: "text", text: compactJson({ saved_asset: asset, response: result.data }) }] };
    }
  );
}

registerSingleFileTool("recraft_vectorize_image", "Vectorize image", "Convert a raster image to SVG.", "images/vectorize");
registerSingleFileTool("recraft_remove_background", "Remove background", "Remove the background from a raster image.", "images/removeBackground");
registerSingleFileTool("recraft_crisp_upscale", "Crisp upscale", "Sharpen and upscale an image.", "images/crispUpscale");
registerSingleFileTool("recraft_creative_upscale", "Creative upscale", "Creatively upscale an image with enhanced detail.", "images/creativeUpscale");

server.registerTool(
  "recraft_erase_region",
  {
    title: "Erase region",
    description: "Erase a masked region from an image.",
    inputSchema: z.object({
      image_path: z.string().min(1),
      mask_path: z.string().min(1),
      response_format: z.enum(RESPONSE_FORMATS).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const form = new FormData();
    const image = await readLocalFile(params.image_path);
    const mask = await readLocalFile(params.mask_path);
    form.append("image", image.blob, image.filename);
    form.append("mask", mask.blob, mask.filename);
    if (params.response_format) form.append("response_format", params.response_format);
    const result = await apiFormRequest("images/eraseRegion", form);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    const asset = await collectSingleImageAsset(result.data, "erase-region");
    return { content: [{ type: "text", text: compactJson({ saved_asset: asset, response: result.data }) }] };
  }
);

server.registerTool(
  "recraft_variate_image",
  {
    title: "Variate image",
    description: "Generate remix variations of an existing image.",
    inputSchema: z.object({
      image_path: z.string().min(1),
      size: z.string().min(1),
      n: z.number().int().min(1).max(6).optional(),
      random_seed: z.string().optional(),
      response_format: z.enum(RESPONSE_FORMATS).optional(),
      image_format: z.enum(IMAGE_FORMATS).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const form = new FormData();
    const image = await readLocalFile(params.image_path);
    form.append("image", image.blob, image.filename);
    for (const [key, value] of Object.entries(params)) {
      if (key === "image_path" || value === undefined) continue;
      form.append(key, String(value));
    }
    const result = await apiFormRequest("images/variateImage", form);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    const saved_assets = await collectGenerationAssets(result.data, "variate-image");
    return { content: [{ type: "text", text: compactJson({ saved_assets, response: result.data }) }] };
  }
);

server.registerTool(
  "recraft_explore",
  {
    title: "Explore",
    description: "Generate a diverse exploratory image set for a prompt.",
    inputSchema: z.object({
      prompt: z.string().min(1).max(4000),
      model: z.enum(EXPLORE_MODELS).optional(),
      size: z.string().optional(),
      response_format: z.enum(RESPONSE_FORMATS).optional(),
      controls: controlsSchema,
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const result = await apiJsonRequest("images/explore", "POST", params as unknown as JsonValue);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    const saved_assets = await collectGenerationAssets(result.data, "explore");
    return { content: [{ type: "text", text: compactJson({ saved_assets, response: result.data }) }] };
  }
);

server.registerTool(
  "recraft_explore_similar",
  {
    title: "Explore similar",
    description: "Generate images visually similar to a previous Explore image.",
    inputSchema: z.object({
      source_image_id: z.string().uuid(),
      similarity: z.number().int().min(1).max(5),
      response_format: z.enum(RESPONSE_FORMATS).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (params) => {
    const result = await apiJsonRequest("images/explore/similar", "POST", params as unknown as JsonValue);
    if (!result.ok) return toolError(result.error || "Unknown error", result.status);
    const saved_assets = await collectGenerationAssets(result.data, "explore-similar");
    return { content: [{ type: "text", text: compactJson({ saved_assets, response: result.data }) }] };
  }
);

async function main() {
  await ensureOutputDir();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Recraft MCP server running via stdio", { output_dir: GENERATED_OUTPUT_DIR });
}

main().catch((error) => {
  logger.error("Server error", error);
  process.exit(1);
});
