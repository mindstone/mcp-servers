# Recraft MCP Server

MCP server for Recraft image generation and editing. It exposes prompt-to-image, style creation, image editing, vectorization, background operations, upscaling, and account inspection tools over stdio for Rebel and other MCP hosts.

MCP (Model Context Protocol) server for Recraft. Compatible with any
MCP host that speaks stdio transport.

## Requirements

- Node.js 18+
- npm
- A Recraft API key (see the "Credentials" section below)

## Install & build

```bash
npm install
npm run build
```

## Run locally

```bash
# Populate .env first (see .env.example)
cp .env.example .env
# Edit .env with your credentials

npm start
```

The server communicates over stdio, so it does not print anything useful when
run directly — point your MCP host at `dist/index.js`.

## Test

```bash
npm test
```

Runs the smoke test which spawns the built server, performs an MCP
handshake, and lists the registered tools. Any tests in the `test/`
directory ending in `.test.mjs` or `.test.ts` are picked up.

## Credentials

Create a Recraft API token in your Recraft profile at https://app.recraft.ai/profile/api. Copy `.env.example` to `.env`, then set `RECRAFT_API_KEY`. The server uses the fixed base URL `https://external.api.recraft.ai/v1`, so you do not need to set a base URL.

## Tools

- `recraft_get_user_info()` — returns the current user profile and credits balance.
- `recraft_generate_image(prompt, model?, size?, style?, style_id?, n?, response_format?, negative_prompt?, controls?, text_layout?)` — generates raster or vector images and returns saved file paths plus raw API metadata.
- `recraft_create_style(style, image_paths[])` — uploads up to 5 reference images and returns a new style ID.
- `recraft_image_to_image(image_path, prompt, strength, ...)` — creates prompt-guided variations of an uploaded image.
- `recraft_inpaint_image(image_path, mask_path, prompt, ...)` — regenerates masked regions of an image.
- `recraft_replace_background(image_path, prompt, ...)` — replaces the detected background.
- `recraft_generate_background(image_path, mask_path, prompt, ...)` — fills masked regions with a generated background.
- `recraft_vectorize_image(image_path, response_format?)` — converts a raster image to SVG and saves the result.
- `recraft_remove_background(image_path, response_format?)` — removes the background and saves the cutout.
- `recraft_crisp_upscale(image_path, response_format?)` — sharpens and upscales an image.
- `recraft_creative_upscale(image_path, response_format?)` — creatively upscales an image with detail enhancement.
- `recraft_erase_region(image_path, mask_path, response_format?)` — erases a masked region from an image.
- `recraft_variate_image(image_path, size, n?, random_seed?, response_format?, image_format?)` — generates remix variations of an image.
- `recraft_explore(prompt, model?, size?, response_format?, controls?)` — returns exploratory generations for a prompt.
- `recraft_explore_similar(source_image_id, similarity, response_format?)` — explores images similar to a prior Explore result.

Each tool returns MCP text output summarising saved file locations plus compact JSON for downstream agent use.

## License

FSL-1.1-MIT. See [LICENSE](LICENSE) for the full terms.

The default LICENSE matches the upstream `nspr-io/mcp-servers` repository so
this connector can be contributed back without changes. If you are not
contributing to that repository, replace the LICENSE with whichever licence
applies to your distribution.
