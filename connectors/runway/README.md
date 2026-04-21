# @mindstone-engineering/mcp-server-runway

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-runway.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-runway)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

Runway ML MCP server for Model Context Protocol hosts. Generate AI video, images, audio, speech, sound effects, and manage custom voices — all through a standardised MCP interface powered by Runway's generative AI models.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/runway
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-runway
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `RUNWAYML_API_SECRET` — Runway API key (from dev.runwayml.com)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`
- `RUNWAY_REQUEST_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the outbound HTTP request timeout applied to Runway JSON API and host-bridge calls. Default: `60000` (60s). Raise this if you see `TIMEOUT` errors on slow submits; lower it if you want tighter bounds.
- `RUNWAY_UPLOAD_TIMEOUT_MS` — optional override (positive integer ms, max 30 min) for the signed-URL upload leg of `uploadEphemeral` (large local-file uploads). Default: `600000` (10 min). Sized for up-to-200MB uploads on typical consumer uplinks (~5 Mbps) with comfortable headroom; raise for slower connections or lower for tighter bounds.

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "Runway": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-runway"],
      "env": {
        "RUNWAYML_API_SECRET": "your-api-key"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "Runway": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/runway/dist/index.js"],
      "env": {
        "RUNWAYML_API_SECRET": "your-api-key"
      }
    }
  }
}
```

## Tools (22)

### Configuration
- `configure_runway_api_key` — Save your Runway API key

### Video
- `generate_video_from_image` — Animate a still image into a video
- `generate_video_from_text` — Create a video from a text description
- `generate_video_from_video` — Re-style or transform an existing video
- `character_performance` — Animate a character with facial expressions and body movements (Act-Two)

### Image
- `generate_image` — Generate an image from text, optionally with reference images

### Audio
- `generate_speech` — Generate spoken audio from text using ElevenLabs voices
- `generate_sound_effect` — Generate sound effects from a text description
- `swap_voice` — Replace the voice in an audio or video file
- `dub_audio` — Translate and dub audio into a different language
- `isolate_voice` — Isolate voice from background audio

### Voices
- `list_custom_voices` — List all custom voices you've created
- `create_custom_voice` — Create a custom voice from a text description
- `preview_voice` — Generate a short audio preview of a voice
- `delete_custom_voice` — Delete a custom voice

### Task management
- `check_runway_task` — Check the status of a generation task
- `wait_for_runway_task` — Wait for a task to complete (auto-poll)
- `cancel_runway_task` — Cancel or delete a task
- `download_runway_output` — Download a Runway output to a local file
- `upload_media` — Upload a local file to Runway's ephemeral storage

### Account
- `get_runway_balance` — Check credit balance, tier limits, and usage
- `query_credit_usage` — Query detailed credit usage by model and day

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.
