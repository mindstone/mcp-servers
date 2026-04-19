# @mindstone-engineering/mcp-server-recraft

Recraft image generation and editing MCP server for Model Context Protocol hosts.

## Requirements

- Node.js 20+
- npm
- Recraft API key

## Quick Start

```bash
cd <path-to-repo>/connectors/recraft
npm install
npm run build
node dist/index.js
```

## Configuration

### Environment variables

- `RECRAFT_API_KEY` — Recraft API key from https://app.recraft.ai/profile/api

## Tools

- `configure_recraft_api_key`
- `recraft_list_styles`
- `recraft__create_style`
- `recraft__generate_image`
- `recraft__image_to_image`
- `recraft__creative_upscale`
- `recraft__replace_background`
- `recraft_remove_background`

## Notes

This is a clean OSS implementation intended to replace or augment the current third-party Recraft connector.
